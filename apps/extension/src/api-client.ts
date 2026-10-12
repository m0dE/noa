/** Runner-side client of the task API: claim, heartbeat, result, media (with the signed-in account's session token). */
import { ClaimResponse, type MediaInfo, type ResultInput } from "@noa/shared";
import { HttpClient } from "./http-client.js";

export interface ApiClientOptions {
  apiBase: string;
  /** The bearer: the signed-in account's session token. */
  token: string;
  fetch?: typeof fetch;
  /** Called on 401 (the token expired or was revoked). */
  onUnauthorized?: () => void;
}

export class ApiClient {
  private readonly http: HttpClient;

  constructor(opts: ApiClientOptions) {
    this.http = new HttpClient({
      apiBase: opts.apiBase,
      token: opts.token,
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
}
