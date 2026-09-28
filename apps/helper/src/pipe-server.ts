/**
 * Named pipe between the helper (server) and the per-task MCP server
 * processes (clients). Newline-delimited JSON carrying RpcPeer messages.
 */
import { timingSafeEqual } from "node:crypto";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RPC_CLOSED, RpcError, RpcPeer, type MethodMap, type PipeMethods, type RpcMessage } from "@noa/shared";
import { encodeLine, LineDecoder } from "./line-framing.js";

/** The side of the pipe that handles no calls. */
type NoMethods = Record<never, never>;

export function pipePathFor(pid: number): string {
  return process.platform === "win32" ? `\\\\.\\pipe\\noa-${pid}` : join(tmpdir(), `noa-${pid}.sock`);
}

/** Connect an RpcPeer to a socket: line framing both ways, close on disconnect. */
function wire<O extends MethodMap, I extends MethodMap>(
  socket: Socket,
  idPrefix: string,
  onError?: (e: Error) => void,
): RpcPeer<O, I> {
  const peer = new RpcPeer<O, I>((msg: RpcMessage) => {
    if (socket.destroyed) throw new RpcError("pipe closed", RPC_CLOSED);
    socket.write(encodeLine(msg));
  }, idPrefix);
  const decoder = new LineDecoder();
  socket.on("data", (chunk: Buffer) => {
    let msgs: unknown[];
    try {
      msgs = decoder.push(chunk);
    } catch (e) {
      onError?.(e as Error);
      socket.destroy();
      return;
    }
    for (const m of msgs) void peer.receive(m as RpcMessage);
  });
  socket.on("close", () => peer.close("pipe closed"));
  socket.on("error", (e) => onError?.(e));
  return peer;
}

/** A pipe call's params without the token (checked before a handler sees them). */
type Unsigned<M extends keyof PipeMethods> = Omit<PipeMethods[M]["params"], "token">;

export interface PipeHandlers {
  toolCall: (params: Unsigned<"tool.call">) => Promise<PipeMethods["tool.call"]["result"]>;
  toolList: (params: Unsigned<"tool.list">) => PipeMethods["tool.list"]["result"];
}

/** The params without their token when it is this helper's; throws otherwise (any other process of the user that finds the pipe). */
function signedBy<P extends { token: string }>(token: string, params: P): Omit<P, "token"> {
  const { token: given, ...rest } = (params ?? {}) as P;
  const a = Buffer.from(typeof given === "string" ? given : "");
  const b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new RpcError("not authorized: the call does not carry this helper's pipe token");
  return rest;
}

export interface PipeServer {
  path: string;
  close(): Promise<void>;
}

/** token: what every call must carry (PipeMethods). */
export function startPipeServer(path: string, token: string, handlers: PipeHandlers, log?: (line: string) => void): Promise<PipeServer> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    log?.("pipe client connected");
    const peer = wire<NoMethods, PipeMethods>(socket, "p", (e) => log?.(`pipe client error: ${e.message}`));
    peer.handle("tool.call", (p) => handlers.toolCall(signedBy(token, p)));
    peer.handle("tool.list", (p) => handlers.toolList(signedBy(token, p)));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      server.on("error", (e) => log?.(`pipe server error: ${e.message}`));
      resolve({
        path,
        close: () =>
          new Promise<void>((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}

export interface PipeClient {
  peer: RpcPeer<PipeMethods, NoMethods>;
  close(): void;
  closed: Promise<void>;
}

export function connectPipe(path: string): Promise<PipeClient> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      const peer = wire<PipeMethods, NoMethods>(socket, "m");
      const closed = new Promise<void>((r) => socket.once("close", () => r()));
      resolve({ peer, close: () => socket.destroy(), closed });
    });
  });
}
