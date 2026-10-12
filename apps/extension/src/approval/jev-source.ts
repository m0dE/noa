/**
 * Which Jev the approval classifier may use for a session (approvalJevSource): the user's own
 * Jev key (TypeSafe's systemOne), else Noa's cloud Jev, the account server's Jev proxy (billed to
 * the account), whatever AI runs the session. Otherwise none: the rules decide and what they are
 * unsure about asks the user. Jev off in Settings: none.
 */
import { proxyJevClient, type JevClientLike } from "@noa/core";
import { SESSION_HEADER, type ExtensionSettings } from "@noa/shared";
import type { SystemOneLike } from "./jev-judge.js";

/** TypeSafe's systemOne endpoint (what its SDK calls; core's createJev uses the SDK). */
export const TYPESAFE_SYSTEMONE_URL = "https://api.typesafe.ai/v1/systemone";

export interface ApprovalJevInput {
  settings: ExtensionSettings;
  /** The signed-in account's session while Noa's cloud Jev can be used (cloudJevUsable), or null. */
  hosted: { token: string; apiBase: string } | null;
  sessionId: string;
  fetch?: typeof fetch;
}

/** The model TypeSafe's SDK asks for by default (the account server's proxy picks its own). */
const TYPESAFE_DEFAULT_MODEL = "jev-latest";

/**
 * JevClientLike types its request as Jev's step state; the classifier sends its own state, which is plain JSON too.
 * model: named for TypeSafe's own endpoint, as its SDK does.
 */
const asSystemOne = (c: JevClientLike, model?: string): SystemOneLike => ({
  systemOne: (request, options) => c.systemOne({ ...request, ...(model ? { model } : {}) } as Parameters<JevClientLike["systemOne"]>[0], options),
});

export function approvalJev(i: ApprovalJevInput): SystemOneLike | null {
  if (!i.settings.jevEnabled) return null;
  const opts = i.fetch ? { fetch: i.fetch } : {};
  if (i.settings.jevApiKey) return asSystemOne(proxyJevClient(TYPESAFE_SYSTEMONE_URL, i.settings.jevApiKey, opts), TYPESAFE_DEFAULT_MODEL);
  if (i.hosted) {
    const base = i.hosted.apiBase.replace(/\/+$/, "");
    return asSystemOne(proxyJevClient(`${base}/v1/ai/jev`, i.hosted.token, { ...opts, headers: { [SESSION_HEADER]: i.sessionId } }));
  }
  return null;
}
