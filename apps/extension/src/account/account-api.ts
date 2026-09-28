/** The signed-in account's API client: sign-in, profile, billing, keys, tasks and media, with the session token. */
import {
  AuthResponse,
  MeBillingResponse,
  MEMORY_PATH,
  MEMORY_SEARCH_PATH,
  MEMORY_SYNC_PATH,
  MemorySearchResponse,
  MemorySyncResponse,
  type MemorySearchInput,
  type MemorySyncInput,
  SESSION_HEADER,
  Task,
  TaskListResponse,
  TRANSCRIBE_CONTENT_TYPE,
  TRANSCRIBE_PATH,
  TRANSCRIBE_QUERY,
  TranscribeResponse,
  VOICE_ENGINES_PATH,
  VoiceEnginesResponse,
  type CreateTaskInput,
  type MediaInfo,
  type UpdateTaskInput,
} from "@noa/shared";
import { HttpClient } from "../http-client.js";
import { Me, type ApiKeyInfo, type CreatedApiKey, type KeyRole } from "./types.js";

export interface AccountApiOptions {
  apiBase: string;
  token?: string;
  fetch?: typeof fetch;
  /** Called on 401 for an authenticated request (the session expired or was revoked). */
  onUnauthorized?: () => void;
}

/** Tasks listed per page (GET /v1/tasks). */
const TASK_PAGE_SIZE = 200;

/** A page of GET /v1/tasks (a server from before plans gated the TODO list sends no `locked`). */
const TaskListPage = TaskListResponse.extend({ locked: TaskListResponse.shape.locked.default(false) });

export type AccountTaskList = { tasks: Task[]; locked: boolean };

export class AccountApi {
  private readonly http: HttpClient;

  constructor(opts: AccountApiOptions) {
    this.http = new HttpClient({ ...opts, missingBase: "The account server URL is not set (Settings > Advanced)" });
  }

  get base(): string {
    return this.http.base;
  }

  /** A session token is set (authenticated calls can be made). */
  get signedIn(): boolean {
    return this.http.hasToken;
  }

  /** GET /v1/config (public): the server's Google client ID ("" when sign-in is not set up there). */
  async googleClientId(): Promise<string> {
    const body = (await (await this.http.request("GET", "/v1/config", undefined, { auth: false })).json()) as { googleClientId?: unknown };
    return typeof body?.googleClientId === "string" ? body.googleClientId.trim() : "";
  }

  /** POST /v1/auth/google (public). */
  signIn(idToken: string): Promise<AuthResponse> {
    return this.http.json(AuthResponse, "POST", "/v1/auth/google", { idToken }, { auth: false });
  }

  async logout(): Promise<void> {
    await this.http.request("POST", "/v1/auth/logout");
  }

  me(): Promise<Me> {
    return this.http.json(Me, "GET", "/v1/me");
  }

  billing(): Promise<MeBillingResponse> {
    return this.http.json(MeBillingResponse, "GET", "/v1/me/billing");
  }

  async listKeys(): Promise<ApiKeyInfo[]> {
    return ((await (await this.http.request("GET", "/v1/me/keys")).json()) as { keys: ApiKeyInfo[] }).keys;
  }

  async createKey(name: string, role: KeyRole): Promise<CreatedApiKey> {
    return (await (await this.http.request("POST", "/v1/me/keys", { name, role })).json()) as CreatedApiKey;
  }

  async revokeKey(id: string): Promise<void> {
    await this.http.request("DELETE", `/v1/me/keys/${encodeURIComponent(id)}`);
  }

  /**
   * Every task of the account (a few pages). locked: the plan does not
   * include the TODO list, so the tasks are read-only until the user subscribes.
   */
  async listTasks(maxPages = 5): Promise<AccountTaskList> {
    const out: AccountTaskList = { tasks: [], locked: false };
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const q = new URLSearchParams({ limit: String(TASK_PAGE_SIZE) });
      if (cursor) q.set("cursor", cursor);
      const body = await this.http.json(TaskListPage, "GET", `/v1/tasks?${q}`);
      out.tasks.push(...body.tasks);
      out.locked = body.locked;
      cursor = body.nextCursor ?? undefined;
      if (!cursor) break;
    }
    return out;
  }

  /** The rows of one task series (a repeating task's runs and its waiting one), newest first: the first page. */
  async listSeries(seriesId: string): Promise<Task[]> {
    return (await this.seriesPage(seriesId)).tasks;
  }

  /** A page of one task series' rows, newest first; `cursor`: the page after the one that gave it (nextCursor null: the last). */
  async seriesPage(seriesId: string, cursor?: string): Promise<{ tasks: Task[]; nextCursor: string | null }> {
    const q = new URLSearchParams({ limit: String(TASK_PAGE_SIZE), series: seriesId });
    if (cursor) q.set("cursor", cursor);
    const { tasks, nextCursor } = await this.http.json(TaskListPage, "GET", `/v1/tasks?${q}`);
    return { tasks, nextCursor };
  }

  createTask(input: CreateTaskInput): Promise<Task> {
    return this.http.json(Task, "POST", "/v1/tasks", input);
  }

  updateTask(id: string, patch: UpdateTaskInput): Promise<Task> {
    return this.http.json(Task, "PATCH", `/v1/tasks/${encodeURIComponent(id)}`, patch);
  }

  async deleteTask(id: string): Promise<void> {
    await this.http.request("DELETE", `/v1/tasks/${encodeURIComponent(id)}`);
  }

  retryTask(id: string): Promise<Task> {
    return this.http.json(Task, "POST", `/v1/tasks/${encodeURIComponent(id)}/retry`);
  }

  /** Keeps a waiting task from running until resumeTask (reason: what it shows; default "Paused by you"). */
  pauseTask(id: string, reason?: string): Promise<Task> {
    return this.http.json(Task, "POST", `/v1/tasks/${encodeURIComponent(id)}/pause`, reason ? { reason } : {});
  }

  /** A paused task waits for its time again (a repeating one whose time went by: its next time). */
  resumeTask(id: string): Promise<Task> {
    return this.http.json(Task, "POST", `/v1/tasks/${encodeURIComponent(id)}/resume`);
  }

  cancelTask(id: string): Promise<Task> {
    return this.http.json(Task, "POST", `/v1/tasks/${encodeURIComponent(id)}/cancel`);
  }

  uploadMedia(blob: Blob, filename: string): Promise<MediaInfo> {
    return this.http.uploadMedia(blob, filename);
  }

  /** GET /v1/billing/voice-engines (public): the hands-free voice engines and what a minute of each costs. */
  /** POST /v1/memory/sync: this browser's memory changes, and the account's since `since` (403 plan_required without the TODO list). */
  memorySync(input: MemorySyncInput): Promise<MemorySyncResponse> {
    return this.http.json(MemorySyncResponse, "POST", MEMORY_SYNC_PATH, input);
  }

  /** POST /v1/memory/search: the synced entries nearest in meaning to `query` (403 plan_required without the TODO list). */
  memorySearch(input: MemorySearchInput): Promise<MemorySearchResponse> {
    return this.http.json(MemorySearchResponse, "POST", MEMORY_SEARCH_PATH, input);
  }

  /** DELETE /v1/memory: forget everything the account keeps (any plan). */
  async forgetMemory(): Promise<void> {
    await this.http.request("DELETE", MEMORY_PATH);
  }

  voiceEngines(): Promise<VoiceEnginesResponse> {
    return this.http.json(VoiceEnginesResponse, "GET", VOICE_ENGINES_PATH, undefined, { auth: false });
  }

  /** POST /v1/ai/transcribe: a WAV clip to text (voice input; paid plans). */
  transcribe(
    wav: Uint8Array,
    opts: { language?: string; speechMs?: number; context?: string; sessionId?: string; signal?: AbortSignal } = {},
  ): Promise<TranscribeResponse> {
    const q = new URLSearchParams();
    if (opts.language) q.set(TRANSCRIBE_QUERY.language, opts.language);
    if (opts.speechMs !== undefined) q.set(TRANSCRIBE_QUERY.speechMs, String(Math.round(opts.speechMs)));
    if (opts.context) q.set(TRANSCRIBE_QUERY.context, opts.context);
    const path = q.size ? `${TRANSCRIBE_PATH}?${q}` : TRANSCRIBE_PATH;
    const body = new Blob([wav as BlobPart], { type: TRANSCRIBE_CONTENT_TYPE });
    return this.http.json(TranscribeResponse, "POST", path, body, {
      ...(opts.sessionId ? { headers: { [SESSION_HEADER]: opts.sessionId } } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  }
}
