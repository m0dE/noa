/**
 * Starts dist/host.js the way Chrome does and speaks native messaging to it
 * as the extension: `ext` calls helper.* methods, and browser.* calls from
 * the helper are answered by `browser` (a fake X page, usually).
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcPeer, type BrowserMethod, type BrowserMethods, type HelperMethods, type HelperNotifications, type RpcMessage } from "@noa/shared";
import { encodeNativeMessage, NativeDecoder } from "../../src/native-framing.js";

export const HOST_JS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "host.js");

/** Every browser.* and vault.* method a task may call. */
export const BROWSER_METHODS: BrowserMethod[] = [
  "browser.navigate",
  "browser.readPage",
  "browser.screenshot",
  "browser.click",
  "browser.type",
  "browser.paste",
  "browser.pressKey",
  "browser.scroll",
  "browser.upload",
  "browser.currentUrl",
  "vault.getCredential",
];

export interface HostProcess {
  child: ChildProcessWithoutNullStreams;
  /** The extension's side of the native messaging channel. */
  ext: RpcPeer<HelperMethods, BrowserMethods>;
  /** helper.event notifications, in order. */
  events: HelperNotifications["helper.event"][];
  /** The open task sessions, as the last helper.sessions notification said. */
  openSessions(): string[];
  /** stdout bytes that were not a valid native message frame (must stay empty). */
  decodeErrors: string[];
  stderr(): string;
}

export function startHost(opts: {
  env: NodeJS.ProcessEnv;
  /** Answers the helper's browser calls. */
  browser: (method: BrowserMethod, params: unknown) => unknown;
  /** Methods to answer (default: all of BROWSER_METHODS). */
  methods?: BrowserMethod[];
  onEvent?: (e: HelperNotifications["helper.event"]) => void;
}): HostProcess {
  const child = spawn(process.execPath, [HOST_JS], { env: opts.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
  const ext = new RpcPeer<HelperMethods, BrowserMethods>((msg) => child.stdin.write(encodeNativeMessage(msg)), "e");
  for (const m of opts.methods ?? BROWSER_METHODS) ext.handle(m, async (p) => (await opts.browser(m, p)) as never);
  const events: HelperNotifications["helper.event"][] = [];
  ext.onNotification<HelperNotifications["helper.event"]>("helper.event", (p) => {
    events.push(p);
    opts.onEvent?.(p);
  });
  let open: string[] = [];
  ext.onNotification<HelperNotifications["helper.sessions"]>("helper.sessions", (p) => (open = p.open));
  const decodeErrors: string[] = [];
  const decoder = new NativeDecoder();
  child.stdout.on("data", (chunk: Buffer) => {
    try {
      for (const msg of decoder.push(chunk)) void ext.receive(msg as RpcMessage);
    } catch (e) {
      decodeErrors.push(String(e));
    }
  });
  return { child, ext, events, openSessions: () => open, decodeErrors, stderr: () => stderr };
}
