/**
 * The one HTTP client for the Noa API: base URL, bearer token, body
 * encoding (JSON, multipart, raw blobs) and error bodies. The runner's task
 * client (api-client.ts) and the account's (account/account-api.ts) are
 * endpoint sets on top of it.
 */
import { errorMessage, MediaInfo, serverMessage } from "@noa/shared";

/** A non-2xx answer: its status, the server's words as the message, and the parsed JSON body (e.g. 409 { portal: true }). */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

/** An authenticated call without a session (signed out, or the session was dropped). */
export class NotSignedInError extends Error {
  constructor() {
    super("Not signed in");
    this.name = "NotSignedInError";
  }
}

export interface HttpClientOptions {
  apiBase: string;
  /** Bearer token of authenticated requests. */
  token?: string;
  fetch?: typeof fetch;
  /** Called on 401 for an authenticated request (the token expired or was revoked). */
  onUnauthorized?: () => void;
  /** The error when apiBase is empty (it says which setting to fill in). */
  missingBase: string;
  /** How errors name the server, e.g. "API" gives "API 409: lease not owned" and "Cannot reach API at …". Default: bare messages. */
  label?: string;
}

export interface RequestOptions {
  /** Send the bearer token (default true). */
  auth?: boolean;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** Longest raw (non-JSON) error text kept in a message. */
const MAX_ERROR_TEXT = 300;

export class HttpClient {
  readonly base: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: HttpClientOptions) {
    this.base = opts.apiBase;
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  get hasToken(): boolean {
    return !!this.opts.token;
  }

  /** Authorization for downloads made elsewhere (the runner fetches media with it). */
  authHeaders(): { name: string; value: string }[] {
    return this.opts.token ? [{ name: "Authorization", value: `Bearer ${this.opts.token}` }] : [];
  }

  /** One request. body: FormData and Blob go as they are, anything else as JSON. Throws ApiRequestError for a non-2xx answer. */
  async request(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<Response> {
    if (!this.base) throw new Error(this.opts.missingBase);
    const auth = opts.auth ?? true;
    const headers: Record<string, string> = { ...opts.headers };
    if (auth) {
      if (!this.opts.token) throw new NotSignedInError();
      headers.authorization = `Bearer ${this.opts.token}`;
    }
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body instanceof Blob) {
      if (body.type) headers["content-type"] = body.type;
      payload = body;
    } else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await this.fetchFn(this.base + path, { method, headers, body: payload, ...(opts.signal ? { signal: opts.signal } : {}) });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      const label = this.opts.label;
      throw new Error(`Cannot reach ${label ? `${label} at ` : ""}${this.base}: ${errorMessage(err)}`);
    }
    if (res.ok) return res;
    if (res.status === 401 && auth) this.opts.onUnauthorized?.();
    throw await this.errorOf(res);
  }

  /** A request whose JSON answer is checked by schema (a shared zod schema). */
  async json<T>(schema: { parse(value: unknown): T }, method: string, path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return schema.parse(await (await this.request(method, path, body, opts)).json());
  }

  /** POST /v1/media: a file in the multipart field "file". */
  uploadMedia(blob: Blob, filename: string): Promise<MediaInfo> {
    const form = new FormData();
    form.append("file", blob, filename);
    return this.json(MediaInfo, "POST", "/v1/media", form);
  }

  private async errorOf(res: Response): Promise<ApiRequestError> {
    const text = await res.text().catch(() => "");
    let body: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
    const status = res.statusText || `HTTP ${res.status}`;
    // A JSON body without words (e.g. only a machine code) says no more than the status. A web page
    // (e.g. a proxy's or Cloudflare's error page) is never shown as text: it says the server isn't answering as the API.
    const isPage = /html/i.test(res.headers.get("content-type") ?? "") || /^\s*</.test(text);
    const said =
      serverMessage(body) ??
      (body ? status : isPage ? `The server answered with a web page instead of the API (HTTP ${res.status}). Check the server address in Settings.` : text.slice(0, MAX_ERROR_TEXT) || status);
    const label = this.opts.label;
    return new ApiRequestError(res.status, label ? `${label} ${res.status}: ${said}` : said, body);
  }
}
