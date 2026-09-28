/** Runner-side client of the task API: claim, heartbeat, result, media (runner key or the account's session token). */
import { ClaimResponse, errorMessage, type MediaInfo, type ResultInput } from "@noa/shared";
import { ApiRequestError, HttpClient } from "./http-client.js";

export interface ApiClientOptions {
  apiBase: string;
  /** The bearer: a runner key, or the signed-in account's session token. */
  runnerKey: string;
  fetch?: typeof fetch;
  /** Called on 401 (the token expired or was revoked). */
  onUnauthorized?: () => void;
}

export class ApiClient {
  private readonly http: HttpClient;

  constructor(opts: ApiClientOptions) {
    this.http = new HttpClient({
      apiBase: opts.apiBase,
      token: opts.runnerKey,
      missingBase: "API base URL is not set",
      label: "API",
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.onUnauthorized ? { onUnauthorized: opts.onUnauthorized } : {}),
    });
  }

  /** Claims the next due task, or null when nothing is due (204). taskId: that task now, whatever its time (Run on its row). */
  async claim(runnerId: string, taskId?: string): Promise<ClaimResponse | null> {
    const res = await this.http.request("POST", "/v1/runner/claim", taskId ? { runnerId, taskId } : { runnerId });
    if (res.status === 204) return null;
    const parsed = ClaimResponse.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new Error(`Unexpected claim response: ${parsed.error.message}`);
    return parsed.data;
  }

  async heartbeat(taskId: string, runnerId: string): Promise<{ leaseExpiresAt: string }> {
    const res = await this.http.request("POST", `/v1/runner/tasks/${encodeURIComponent(taskId)}/heartbeat`, { runnerId });
    return (await res.json()) as { leaseExpiresAt: string };
  }

  /** Reports how a claimed task ended. outcome "retry" sends it back to pending after retryAfterMinutes. */
  async result(taskId: string, body: ResultInput): Promise<void> {
    await this.http.request("POST", `/v1/runner/tasks/${encodeURIComponent(taskId)}/result`, body);
  }

  uploadMedia(blob: Blob, filename: string): Promise<MediaInfo> {
    return this.http.uploadMedia(blob, filename);
  }

  /** Download URL of a media file; fetch it with authHeaders(). */
  mediaUrl(mediaId: string): string {
    return `${this.http.base}/v1/media/${encodeURIComponent(mediaId)}`;
  }

  authHeaders(): { name: string; value: string }[] {
    return this.http.authHeaders();
  }

  /** Checks that the API is reachable and accepts the runner key. */
  async check(): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await this.http.request("GET", "/", undefined, { auth: false });
      // An unknown media ID answers 404 for a valid key and 401/403 otherwise.
      await this.http.request("GET", `/v1/media/noa-check-${Date.now()}`).catch((err: unknown) => {
        if (err instanceof ApiRequestError && err.status === 404) return;
        throw err;
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }
}
