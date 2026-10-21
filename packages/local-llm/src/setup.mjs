/**
 * `npx noa-local-llm`: everything Noa's Local model needs, in one command.
 *
 * 1. Noa's helper, from noa.bot's installer (the one Settings shows for the helper).
 * 2. OpenCode, the open-source agent the helper runs the model on (web search, web pages, skills, Noa's browser
 *    tools), into Noa's folder, at the version Noa was tested with.
 * 3. Ollama, from its own installer when there is none, started when it is not running.
 * 4. A model (qwen3:8b unless --model names another), and a copy of it with a context Noa fits in
 *    (noa-<model>: Ollama gives models 4k tokens on a computer without a graphics card, and Noa's
 *    instructions and tools take more).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_MODEL = "qwen3:8b";
export const OLLAMA_URL = "http://localhost:11434";
/** The OpenCode version the helper's config was tested with (apps/helper/src/opencode-process.ts). */
export const OPENCODE_VERSION = "1.19.3";
/** The context the copy of the model gets: the helper tells OpenCode the same (LOCAL_MODEL_LIMIT). */
export const NUM_CTX = 32768;
const HELPER_BASE = "https://noa.bot/helper";

const USAGE = `Usage: npx -y noa-local-llm [options]

Sets up Noa's Local model: Noa's helper, OpenCode, Ollama and a model.

Options:
  --model <name>         Ollama model to download (default ${DEFAULT_MODEL}); it must be able to call tools
  --extension-id <id>    Noa's extension id, when it is not the Chrome Web Store's (Settings shows the command with it)
  --helper-code <code>   The helper version the extension expects (Settings shows the command with it)
  --skip-helper          Do not install Noa's helper
  -h, --help             This text`;

/** The command line as options; throws on an unknown or incomplete one. */
export function parseArgs(argv) {
  const out = { model: DEFAULT_MODEL, extensionId: null, helperCode: null, skipHelper: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--model") out.model = value();
    else if (a === "--extension-id") out.extensionId = value();
    else if (a === "--helper-code") out.helperCode = value();
    else if (a === "--skip-helper") out.skipHelper = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else throw new Error(`Unknown option ${a}\n\n${USAGE}`);
  }
  if (out.extensionId && !/^[a-p]{32}$/.test(out.extensionId)) throw new Error(`Not a Chrome extension id: ${out.extensionId}`);
  if (out.helperCode && !/^[0-9a-f]{12}$/.test(out.helperCode)) throw new Error(`Not a helper code: ${out.helperCode}`);
  return out;
}

/** Noa's folder, as the helper finds it (apps/helper/src/config.ts): NOA_HOME, else the system's app data folder. */
export function noaHome(env = process.env, platform = process.platform) {
  if (env.NOA_HOME) return env.NOA_HOME;
  const appData = env.LOCALAPPDATA || (platform === "win32" ? join(homedir(), "AppData", "Local") : platform === "darwin" ? join(homedir(), "Library", "Application Support") : env.XDG_DATA_HOME || join(homedir(), ".local", "share"));
  return join(appData, "noa");
}

/** The helper's installer for this system (and helper code, when given). */
export function helperInstallerUrl(platform, code) {
  return `${HELPER_BASE}/${code ? `${code}/` : ""}install.${platform === "win32" ? "ps1" : "sh"}`;
}

/** The copy of `model` with Noa's context: "noa-qwen3:8b" for "qwen3:8b". */
export function noaModelName(model) {
  return `noa-${model.replace(/^.*\//, "")}`;
}

function step(text) {
  console.log(`\n==> ${text}`);
}

/** Runs a command with the terminal attached; throws when it fails. */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.error) throw new Error(`Could not run ${cmd}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (exit code ${r.status})`);
}

function which(name) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf8" });
  const first = r.status === 0 ? r.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean) : undefined;
  return first || null;
}

async function installHelper(opts) {
  step("Installing Noa's helper");
  const url = helperInstallerUrl(process.platform, opts.helperCode);
  // The installer of a new helper version is on noa.bot once that version is released.
  const head = await fetch(url, { method: "HEAD" }).catch((e) => {
    throw new Error(`Could not reach noa.bot for the helper's installer (${e.message}). Check your internet connection.`);
  });
  if (!head.ok) throw new Error(`The helper for this version of Noa is not on noa.bot yet (${url} answered HTTP ${head.status}). Try again in a few minutes.`);
  if (process.platform === "win32") {
    const setId = opts.extensionId ? `$env:NOA_EXTENSION_ID='${opts.extensionId}'; ` : "";
    run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `${setId}irm ${url} | iex`]);
  } else {
    run("sh", ["-c", `curl -fsSL ${url} | sh -s --${opts.extensionId ? ` --extension-id ${opts.extensionId}` : ""}`]);
  }
}

function installOpencode(home) {
  const prefix = join(home, "opencode");
  const pkg = join(prefix, "node_modules", "opencode-ai", "package.json");
  const installed = existsSync(pkg) ? JSON.parse(readFileSync(pkg, "utf8")).version : null;
  if (installed === OPENCODE_VERSION) {
    step(`OpenCode ${OPENCODE_VERSION} is already in ${prefix}`);
    return;
  }
  step(`Installing OpenCode ${OPENCODE_VERSION} into ${prefix}`);
  // shell: npm is npm.cmd on Windows.
  run("npm", ["install", "--prefix", prefix, "--no-fund", "--no-audit", `opencode-ai@${OPENCODE_VERSION}`], { shell: process.platform === "win32" });
}

async function ollamaUp(fetchFn = fetch) {
  try {
    const r = await fetchFn(`${OLLAMA_URL}/api/version`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

/** The Ollama command: on the PATH, or where its app keeps it. */
function findOllama() {
  const onPath = which("ollama");
  if (onPath) return onPath;
  const known =
    process.platform === "darwin"
      ? ["/Applications/Ollama.app/Contents/Resources/ollama"]
      : process.platform === "win32"
        ? [join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Programs", "Ollama", "ollama.exe")]
        : ["/usr/local/bin/ollama", "/usr/bin/ollama"];
  return known.find((p) => existsSync(p)) ?? null;
}

async function ensureOllama() {
  if (await ollamaUp()) {
    step(`Ollama is running at ${OLLAMA_URL}`);
    return;
  }
  let ollama = findOllama();
  if (!ollama) {
    step("Installing Ollama with its own installer (https://ollama.com)");
    if (process.platform === "win32") run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://ollama.com/install.ps1 | iex"]);
    else run("sh", ["-c", "curl -fsSL https://ollama.com/install.sh | sh"], { env: { ...process.env, OLLAMA_NO_START: "1" } });
    ollama = findOllama();
    if (!ollama && !(await ollamaUp())) throw new Error("Ollama was installed but its command was not found. Open a new terminal and run this again.");
  }
  if (!(await ollamaUp())) {
    step("Starting Ollama");
    if (process.platform === "darwin" && existsSync("/Applications/Ollama.app")) run("open", ["-a", "Ollama", "--args", "hidden"]);
    else spawn(ollama, ["serve"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  }
  for (let i = 0; i < 60; i++) {
    if (await ollamaUp()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Ollama did not start: nothing answers at ${OLLAMA_URL}`);
}

async function ollamaModels() {
  const r = await fetch(`${OLLAMA_URL}/api/tags`);
  const body = await r.json();
  return (body.models ?? []).map((m) => m.name);
}

/** Ollama's names say "qwen3:8b"; one without a tag means ":latest". */
function hasModel(models, name) {
  const full = name.includes(":") ? name : `${name}:latest`;
  return models.includes(full);
}

/** POSTs to Ollama's streaming API, printing its progress lines; throws on an error line. */
async function ollamaStream(path, body, label) {
  const r = await fetch(`${OLLAMA_URL}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok || !r.body) throw new Error(`Ollama ${path} answered HTTP ${r.status}: ${await r.text()}`);
  const decoder = new TextDecoder();
  let buffer = "";
  let last = "";
  for await (const chunk of r.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const j = JSON.parse(line);
      if (j.error) throw new Error(`${label}: ${j.error}`);
      const pct = j.total ? ` ${Math.floor(((j.completed ?? 0) / j.total) * 100)}%` : "";
      const text = `${j.status ?? ""}${pct}`;
      if (text !== last) {
        if (process.stdout.isTTY) process.stdout.write(`\r\x1b[K   ${text}`);
        else if (!pct || pct.endsWith("0%")) console.log(`   ${text}`);
        last = text;
      }
    }
  }
  if (process.stdout.isTTY) process.stdout.write("\n");
}

async function ensureModel(model) {
  const noaModel = noaModelName(model);
  let models = await ollamaModels();
  if (!hasModel(models, model)) {
    step(`Downloading ${model} (a few GB: this takes a while)`);
    await ollamaStream("/api/pull", { model }, `Downloading ${model}`);
  } else step(`${model} is already downloaded`);
  step(`Making ${noaModel}: ${model} with a ${NUM_CTX / 1024}k context for Noa's instructions and pages`);
  await ollamaStream("/api/create", { model: noaModel, from: model, parameters: { num_ctx: NUM_CTX } }, `Making ${noaModel}`);
  models = await ollamaModels();
  if (!hasModel(models, noaModel)) throw new Error(`Ollama does not list ${noaModel} after making it`);
  return noaModel;
}

export async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  if (!opts.skipHelper) await installHelper(opts);
  installOpencode(noaHome());
  await ensureOllama();
  const model = await ensureModel(opts.model);
  console.log(`
Done. Noa's Local model is ready.

In Chrome, open Noa's Settings > AI, pick "Local model" and click Find models.
Pick ${model} if it is not picked already.

Ollama keeps running in the background; it starts with your computer if its installer set it up so.`);
  return 0;
}
