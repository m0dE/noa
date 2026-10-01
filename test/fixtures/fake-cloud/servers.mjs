// Local stand-ins for the services the API Worker talks to, for the
// full-stack e2e (wrangler dev with DEV_TEST_HOOKS=1, see apps/api/src/dev-hooks.ts):
//
// - createFakeGoogle(): a JWKS endpoint with a generated RSA key, and a
//   /mint endpoint (plus mint()) that issues Google-style ID tokens.
// - createFakeAnthropic(): the Messages API, playing the tool-use conversation
//   a real Claude has when posting on the fake X (switch_x_account, navigate,
//   read_page, act with element indexes, read_page, task_complete with the
//   post URL). It decides each reply from the request alone: the task prompt,
//   the tools offered and the tool results so far.
// - createFakeStripe(): customers, Checkout Sessions and portal sessions
//   (enough for the checkout/topup/portal routes); records what was created.
// - createFakeTypeSafe(): the Jev systemOne endpoint.
// - createFakeOpenAiRealtime(): OpenAI's Realtime WebSocket (/v1/realtime), a minimal RFC 6455
//   server (no dependencies): session.created on connect, each session.update answered with
//   session.updated (the session so far), each response.create answered with response.created,
//   one audio delta and a response.done carrying FAKE_REALTIME_USAGE; userSpoke() and
//   transcribed() play the user's turn and its input transcription.
// - stripeEvent(), signStripeWebhook(): a Stripe event and its Stripe-Signature
//   header, the way Stripe sends webhooks.

import { createHash, createHmac, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";

/** The plan table and Stripe contract the API reads (packages/shared/src/billing-catalog.json). */
const BILLING_CATALOG = JSON.parse(readFileSync(new URL("../../../packages/shared/src/billing-catalog.json", import.meta.url), "utf8"));

function listenOn(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function sendJson(res, status, obj, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(obj));
}

function makeServer(handler) {
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: String(err?.stack ?? err) });
    });
  });
  return {
    server,
    async listen() {
      this.url = await listenOn(server);
      return this.url;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// ---- Google ------------------------------------------------------------------

export function createFakeGoogle({ clientId }) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = `e2e-${randomBytes(4).toString("hex")}`;
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
  let jwksFetches = 0;

  /**
   * A signed ID token like Google's (RS256), for `claims.sub` (default "e2e-user"), issued now and
   * valid for an hour; the same standard claims as the API tests' claims() (apps/api/test/helpers.ts).
   */
  function mint(claims = {}) {
    const now = Math.floor(Date.now() / 1000);
    const sub = claims.sub ?? "e2e-user";
    const payload = {
      iss: "https://accounts.google.com",
      aud: clientId,
      sub,
      email: `${sub}@example.com`,
      email_verified: true,
      name: `User ${sub}`,
      picture: `https://pics.test/${sub}.png`,
      iat: now,
      exp: now + 3600,
      ...claims,
    };
    const h = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
    const p = b64url(JSON.stringify(payload));
    const sig = createSign("RSA-SHA256").update(`${h}.${p}`).sign(privateKey);
    return `${h}.${p}.${b64url(sig)}`;
  }

  const srv = makeServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/jwks") {
      jwksFetches++;
      return sendJson(res, 200, { keys: [jwk] }, { "cache-control": "public, max-age=3600" });
    }
    if (url.pathname === "/mint") {
      // What Google's OAuth endpoint would put in the redirect: an ID token with the request's nonce.
      const claims = {};
      for (const k of ["sub", "email", "name", "nonce", "aud"]) if (url.searchParams.get(k)) claims[k] = url.searchParams.get(k);
      res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
      return res.end(mint(claims));
    }
    sendJson(res, 404, { error: "not found" });
  });
  return Object.assign(srv, { mint, jwksUrl: () => `${srv.url}/jwks`, jwksFetches: () => jwksFetches });
}

// ---- Anthropic -----------------------------------------------------------------

const ELEMENT_LINE = /^\[(\d+)\] (\S+) ("(?:[^"\\]|\\.)*") \((.*)\)$/;

/** The element list and visible text of a read_page result. */
export function parsePage(text) {
  const page = { url: "", text: "", elements: [] };
  const lines = String(text ?? "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === "--- visible text ---") {
      page.text = lines.slice(i + 1).join("\n");
      break;
    }
    if (line.startsWith("URL: ")) page.url = line.slice(5);
    const m = ELEMENT_LINE.exec(line);
    if (!m) continue;
    const el = { index: Number(m[1]), role: m[2], name: JSON.parse(m[3]) };
    for (const part of m[4].split(", ")) {
      if (part.startsWith("testid=")) el.testId = part.slice(7);
      else if (part.startsWith("href=")) el.href = part.slice(5);
      else if (part.startsWith("type=")) el.type = part.slice(5);
    }
    page.elements.push(el);
  }
  return page;
}

export const textOf = (content) =>
  (Array.isArray(content) ? content : [{ type: "text", text: String(content ?? "") }])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

/** The tool calls so far, each with its result text. */
export function history(messages) {
  const calls = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    const results = new Map();
    for (const b of messages[i + 1]?.content ?? []) if (b?.type === "tool_result") results.set(b.tool_use_id, textOf(b.content));
    for (const b of m.content) if (b.type === "tool_use") calls.push({ name: b.name, input: b.input ?? {}, result: results.get(b.id) ?? "" });
  }
  return calls;
}

/**
 * The next step of "post the task's text on the fake X", like Claude would
 * take it. Returns { text, tool: { name, input } }.
 */
export function nextPostingStep(body) {
  const tools = new Set((body.tools ?? []).map((t) => t.name));
  const need = ["switch_x_account", "navigate", "read_page", "act", "task_complete", "task_fail"];
  const missing = need.filter((n) => !tools.has(n));
  if (missing.length) return { text: "I cannot do this without my tools.", tool: { name: "task_fail", input: { reason: `tools missing: ${missing.join(", ")}` } } };

  const prompt = textOf(body.messages?.[0]?.content);
  const account = /^Account: (@[A-Za-z0-9_]+)/m.exec(prompt)?.[1] ?? null;
  const instructions = /<<<\n([\s\S]*?)\n>>>/.exec(prompt)?.[1] ?? "";
  const postText = (instructions.includes("Post:") ? instructions.slice(instructions.indexOf("Post:") + 5) : instructions).trim();
  const isRetry = /this is a retry/i.test(prompt);
  const calls = history(body.messages ?? []);
  const last = calls.at(-1);
  const handle = account ? account.slice(1) : null;
  const profileUrl = handle ? `https://x.com/${handle}` : null;
  const complete = (url) => ({ text: "The post is live.", tool: { name: "task_complete", input: { summary: `Posted: ${postText.slice(0, 200)}`, url } } });

  if (account && !calls.some((c) => c.name === "switch_x_account")) {
    return { text: `Switching to ${account} first.`, tool: { name: "switch_x_account", input: { handle: account } } };
  }
  if (isRetry && profileUrl) {
    // Check the profile for a post from the interrupted attempt before posting.
    if (!calls.some((c) => c.name === "navigate" && c.input.url === profileUrl)) {
      return { text: "This is a retry: checking the profile first.", tool: { name: "navigate", input: { url: profileUrl } } };
    }
    if (last?.name === "navigate" && last.input.url === profileUrl) return { text: "", tool: { name: "read_page", input: {} } };
    const profileRead = calls.findIndex((c, i) => c.name === "read_page" && calls[i - 1]?.name === "navigate" && calls[i - 1].input.url === profileUrl);
    if (profileRead === calls.length - 1) {
      const page = parsePage(last.result);
      if (page.text.includes(postText)) {
        const link = page.elements.find((e) => e.href && /\/status\/\d+/.test(e.href));
        if (link) return complete(link.href);
      }
    }
  }
  if (!calls.some((c) => c.name === "navigate" && c.input.url === "https://x.com/home")) {
    return { text: "Opening the home timeline.", tool: { name: "navigate", input: { url: "https://x.com/home" } } };
  }
  const actAt = calls.findIndex((c) => c.name === "act");
  if (actAt < 0) {
    if (last?.name !== "read_page") return { text: "", tool: { name: "read_page", input: {} } };
    const page = parsePage(last.result);
    const box = page.elements.find((e) => e.role === "textbox" && e.type !== "file");
    const post = page.elements.find((e) => e.testId === "tweetButtonInline" || e.testId === "tweetButton");
    if (!box || !post) return { text: "", tool: { name: "task_fail", input: { reason: `no composer on ${page.url}` } } };
    return {
      text: "Typing the post and sending it.",
      tool: { name: "act", input: { steps: [{ goal: "type the post text", index: box.index, text: postText }, { goal: "click Post", index: post.index }] } },
    };
  }
  const readsAfter = calls.slice(actAt + 1).filter((c) => c.name === "read_page");
  const view = readsAfter.length ? parsePage(readsAfter.at(-1).result).elements.find((e) => e.name.trim() === "View" && /\/status\/\d+/.test(e.href ?? "")) : null;
  if (view) return complete(view.href);
  if (readsAfter.length >= 5) return { text: "", tool: { name: "task_fail", input: { reason: "the post did not show up" } } };
  return { text: "", tool: { name: "read_page", input: {} } };
}

/** Usage each reply reports (claude-sonnet-5: 10k in, 2k out). */
export const FAKE_USAGE = { input_tokens: 10_000, output_tokens: 2_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

/**
 * plan: the next reply for a request body, { text, tool } or { text, tools: [...] } for several tool calls in one
 * reply (default: nextPostingStep, the post on the fake X).
 */
export function createFakeAnthropic({ plan = nextPostingStep } = {}) {
  const requests = [];
  let drainNext = false;
  const srv = makeServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method !== "POST" || url.pathname !== "/v1/messages") return sendJson(res, 404, { type: "error", error: { type: "not_found_error", message: "not found" } });
    const raw = await readBody(req);
    const body = JSON.parse(raw);
    const step = plan(body);
    const tools = step.tools ?? [step.tool];
    let usage = FAKE_USAGE;
    if (drainNext) {
      // One very large request: takes the balance below zero (the server allows that once).
      drainNext = false;
      usage = { ...FAKE_USAGE, input_tokens: 5_000_000 };
    }
    requests.push({ headers: req.headers, model: body.model, tool: tools.map((t) => t.name).join(","), usage, body });
    const content = [];
    if (step.text) content.push({ type: "text", text: step.text });
    for (const t of tools) content.push({ type: "tool_use", id: `toolu_${randomBytes(8).toString("hex")}`, name: t.name, input: t.input });
    sendJson(res, 200, {
      id: `msg_${randomBytes(8).toString("hex")}`,
      type: "message",
      role: "assistant",
      model: body.model,
      content,
      stop_reason: "tool_use",
      stop_sequence: null,
      usage,
    });
  });
  return Object.assign(srv, {
    requests: () => requests,
    /** The next reply reports 5M input tokens (about $13 charged). */
    drainNextRequest: () => {
      drainNext = true;
    },
  });
}

// ---- Stripe ------------------------------------------------------------------

/** Stripe's bracket form encoding back into an object (a[b][0]=v). */
export function parseStripeForm(raw) {
  const out = {};
  for (const [key, value] of new URLSearchParams(raw)) {
    const path = key.split(/\[|\]\[|\]/).filter((p) => p !== "");
    let o = out;
    path.forEach((p, i) => {
      if (i === path.length - 1) o[p] = value;
      else o = o[p] ??= {};
    });
  }
  return out;
}

export function createFakeStripe() {
  let n = 0;
  const customers = [];
  const sessions = [];
  const portals = [];
  const srv = makeServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (!/^Bearer sk_test_/.test(req.headers.authorization ?? "")) return sendJson(res, 401, { error: { message: "Invalid API Key provided" } });
    const params = req.method === "POST" ? parseStripeForm(await readBody(req)) : {};
    if (req.method === "POST" && url.pathname === "/v1/customers") {
      const c = { id: `cus_e2e${++n}`, object: "customer", ...params };
      customers.push(c);
      return sendJson(res, 200, c);
    }
    if (req.method === "POST" && url.pathname === "/v1/checkout/sessions") {
      const id = `cs_test_e2e${++n}`;
      const s = { id, object: "checkout.session", url: `https://checkout.stripe.test/c/pay/${id}`, ...params };
      sessions.push(s);
      return sendJson(res, 200, s);
    }
    if (req.method === "POST" && url.pathname === "/v1/billing_portal/sessions") {
      const s = { id: `bps_e2e${++n}`, object: "billing_portal.session", url: `https://billing.stripe.test/p/session/${n}`, ...params };
      portals.push(s);
      return sendJson(res, 200, s);
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/v1/subscriptions/")) {
      return sendJson(res, 200, { id: url.pathname.split("/").pop(), object: "subscription", status: "canceled" });
    }
    sendJson(res, 404, { error: { message: `no fake for ${req.method} ${url.pathname}` } });
  });
  return Object.assign(srv, { customers: () => customers, sessions: () => sessions, portals: () => portals });
}

let eventSeq = 0;
/** A Stripe event (https://docs.stripe.com/api/events/object) of `type` around `object`, on the API version the server is pinned to. */
export function stripeEvent(type, object) {
  return {
    id: `evt_e2e_${Date.now()}_${++eventSeq}`,
    object: "event",
    api_version: BILLING_CATALOG.stripe.apiVersion,
    created: Math.floor(Date.now() / 1000),
    type,
    data: { object },
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
  };
}

/** The Stripe-Signature header for a payload: t=<unix>,v1=HMAC-SHA256(secret, "<t>.<payload>"). */
export function signStripeWebhook(payload, secret, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;
}

// ---- TypeSafe (Jev) ------------------------------------------------------------

export function createFakeTypeSafe() {
  const requests = [];
  const srv = makeServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method !== "POST" || url.pathname !== "/v1/systemone") return sendJson(res, 404, { error: "not found" });
    const body = JSON.parse(await readBody(req));
    requests.push({ headers: req.headers, body });
    const answers = Object.fromEntries(Object.keys(body.questions ?? {}).map((k) => [k, { noul: "yes", probabilities: { yes: 0.97, no: 0.03 } }]));
    sendJson(res, 200, { model: "jev-e2e", answers, usage: { input_tokens: 50_000, output_tokens: 12 } });
  });
  return Object.assign(srv, { requests: () => requests });
}

// ---- Workers AI (voice transcription) ----------------------------------------------

export const FAKE_TRANSCRIPT = "Open Gmail and reply to Sarah.";
/** The fake's embedding size: the API's default model's (bge-m3), which it checks. */
export const FAKE_EMBEDDING_DIMS = 1024;

/** A deterministic stand-in embedding (NOT semantic): each lower-case word adds to one hashed dimension. */
export function fakeEmbedding(text) {
  const v = new Array(FAKE_EMBEDDING_DIMS).fill(0);
  for (const w of String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) v[createHash("md5").update(w).digest().readUInt32LE(0) % FAKE_EMBEDDING_DIMS] += 1;
  return v;
}

/** What the fake Deepgram voice answers unless given audio: a few MP3 frame-header bytes (not playable). */
export const FAKE_SPEECH_MP3 = Buffer.from([0xff, 0xfb, 0x90, 0x44, 0, 0, 0, 0]);

/**
 * Workers AI's REST API shape (POST /ai/run/<model>, { success, result, errors }) for
 * the API's WORKERS_AI_BASE_URL dev hook: Whisper answers FAKE_TRANSCRIPT for a WAV
 * and fails like the real one (3030) for anything else. Deepgram's voice (Aura: { text,
 * speaker }) answers audio/mpeg, `speechAudio` (real MP3 bytes for a live run) or FAKE_SPEECH_MP3.
 */
export function createFakeWorkersAi({ speechAudio = FAKE_SPEECH_MP3 } = {}) {
  const requests = [];
  const srv = makeServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const model = url.pathname.replace(/^\/ai\/run\//, "");
    if (req.method !== "POST" || model === url.pathname) return sendJson(res, 404, { success: false, errors: [{ message: "not found" }] });
    const body = JSON.parse(await readBody(req));
    if (model.includes("/aura") && typeof body.text === "string") {
      requests.push({ model, body, audioBytes: 0 });
      res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": speechAudio.length });
      return res.end(speechAudio);
    }
    // Text embeddings (memory search): { text: string[] } -> one deterministic vector per text.
    if (Array.isArray(body.text)) {
      requests.push({ model, body, audioBytes: 0 });
      return sendJson(res, 200, { success: true, errors: [], result: { shape: [body.text.length, FAKE_EMBEDDING_DIMS], data: body.text.map(fakeEmbedding), pooling: "cls" } });
    }
    const audio = Buffer.from(typeof body.audio === "string" ? body.audio : body.audio?.body ?? "", "base64");
    requests.push({ model, body, audioBytes: audio.length });
    if (audio.subarray(0, 4).toString("latin1") !== "RIFF") {
      return sendJson(res, 400, { success: false, result: null, errors: [{ code: 3030, message: "3030: Failed to decode audio file." }] });
    }
    const seconds = (audio.length - 44) / 32000;
    sendJson(res, 200, {
      success: true,
      errors: [],
      result: { text: FAKE_TRANSCRIPT, transcription_info: { language: "en", duration: seconds, duration_after_vad: seconds }, segments: [] },
    });
  });
  return Object.assign(srv, { requests: () => requests });
}

// ---- OpenAI Realtime ------------------------------------------------------------

/** The usage of every fake response.done (the shape of OpenAI's documented example). */
export const FAKE_REALTIME_USAGE = {
  total_tokens: 1_900,
  input_tokens: 1_000,
  output_tokens: 900,
  input_token_details: { text_tokens: 400, audio_tokens: 600, image_tokens: 0, cached_tokens: 200, cached_tokens_details: { text_tokens: 200, audio_tokens: 0, image_tokens: 0 } },
  output_token_details: { text_tokens: 300, audio_tokens: 600 },
};

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** One server-side WebSocket over a raw socket: text frames out (unmasked), frames in (masked, maybe fragmented). */
function serverSocket(socket, { onText, onClose }) {
  let buf = Buffer.alloc(0);
  let fragments = [];
  let closed = false;
  const frame = (opcode, payload) => {
    const len = payload.length;
    const head = len < 126 ? Buffer.from([0x80 | opcode, len]) : len < 65536 ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 255]) : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()]);
    if (!socket.destroyed) socket.write(Buffer.concat([head, payload]));
  };
  const close = (code = 1000) => {
    if (closed) return;
    closed = true;
    const p = Buffer.alloc(2);
    p.writeUInt16BE(code);
    frame(8, p);
    socket.end();
  };
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let at = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        at = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        at = 10;
      }
      const mask = masked ? buf.subarray(at, at + 4) : null;
      if (masked) at += 4;
      if (buf.length < at + len) return;
      const payload = Buffer.from(buf.subarray(at, at + len));
      buf = buf.subarray(at + len);
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      if (opcode === 8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        close(code === 1005 ? 1000 : code);
        onClose(code);
        return;
      }
      if (opcode === 9) frame(10, payload);
      if (opcode === 1 || opcode === 0) {
        fragments.push(payload);
        if (fin) {
          const text = Buffer.concat(fragments).toString("utf8");
          fragments = [];
          onText(text);
        }
      }
    }
  });
  socket.on("close", () => {
    if (!closed) onClose(1006);
    closed = true;
  });
  return { send: (text) => frame(1, Buffer.from(text, "utf8")), close };
}

export function createFakeOpenAiRealtime() {
  const connections = [];
  const srv = makeServer((req, res) => sendJson(res, 426, { error: { message: "WebSocket only" } }));
  srv.server.on("upgrade", (req, socket) => {
    const url = new URL(req.url, "http://x");
    const key = req.headers["sec-websocket-key"];
    /** An HTTP/1.1 response head (and body) on the raw socket. */
    const head = (status, headers, body = "") => [status, ...headers, "", body].join("\r\n");
    if (url.pathname !== "/v1/realtime" || !key) {
      socket.end(head("HTTP/1.1 404 Not Found", ["Content-Length: 0"]));
      return;
    }
    if (req.headers.authorization !== "Bearer fake-openai") {
      const body = JSON.stringify({ error: { message: "Incorrect API key provided.", type: "invalid_request_error", code: "invalid_api_key" } });
      socket.end(head("HTTP/1.1 401 Unauthorized", ["Content-Type: application/json", `Content-Length: ${Buffer.byteLength(body)}`], body));
      return;
    }
    const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(head("HTTP/1.1 101 Switching Protocols", ["Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`]));
    const conn = { model: url.searchParams.get("model"), headers: req.headers, received: [], closedWith: null };
    conn.session = { type: "realtime", model: conn.model };
    connections.push(conn);
    let responses = 0;
    const ws = serverSocket(socket, {
      onText(text) {
        conn.received.push(text);
        let event;
        try {
          event = JSON.parse(text);
        } catch {
          return;
        }
        if (event.type === "session.update") {
          // As OpenAI does: the whole session as it is now (the relay reads the input transcription model from it).
          conn.session = { ...conn.session, ...event.session };
          ws.send(JSON.stringify({ type: "session.updated", event_id: `ev_update_${conn.received.length}`, session: conn.session }));
        }
        if (event.type === "response.create") {
          const id = `resp_fake_${++responses}`;
          ws.send(JSON.stringify({ type: "response.created", event_id: `ev_${id}_1`, response: { id, status: "in_progress" } }));
          ws.send(JSON.stringify({ type: "response.output_audio.delta", event_id: `ev_${id}_2`, response_id: id, delta: "AAAA" }));
          ws.send(JSON.stringify({ type: "response.done", event_id: `ev_${id}_3`, response: { id, status: "completed", usage: FAKE_REALTIME_USAGE } }));
        }
      },
      onClose(code) {
        conn.closedWith = code;
      },
    });
    /** Plays a server event to the client (e.g. a function call of the model), as OpenAI would send it. */
    conn.emit = (event) => ws.send(JSON.stringify(event));
    /** The user's turn as server VAD reports it: speech starts and stops, and the audio is committed as input item `itemId`. */
    conn.userSpoke = (itemId) => {
      conn.emit({ type: "input_audio_buffer.speech_started", event_id: `ev_${itemId}_start`, audio_start_ms: 1000, item_id: itemId });
      conn.emit({ type: "input_audio_buffer.speech_stopped", event_id: `ev_${itemId}_stop`, audio_end_ms: 3000, item_id: itemId });
      conn.emit({ type: "input_audio_buffer.committed", event_id: `ev_${itemId}_commit`, previous_item_id: null, item_id: itemId });
    };
    /** The input transcription of item `itemId` (it arrives on its own time, often after the reply began), with its usage. */
    conn.transcribed = (itemId, transcript, seconds = 2) =>
      conn.emit({
        type: "conversation.item.input_audio_transcription.completed",
        event_id: `ev_${itemId}_transcript`,
        item_id: itemId,
        content_index: 0,
        transcript,
        usage: { type: "duration", seconds },
      });
    ws.send(JSON.stringify({ type: "session.created", event_id: "ev_session", session: { type: "realtime", model: conn.model } }));
  });
  return Object.assign(srv, { connections: () => connections });
}
