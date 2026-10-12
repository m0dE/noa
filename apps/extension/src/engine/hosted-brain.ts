/**
 * The hosted "Noa AI" brain: the same agent loop as the Claude API
 * brain, sent to the account server instead of Anthropic. Messages go to
 * `${apiBase}/v1/ai/messages` and Jev to `${apiBase}/v1/ai/jev`, with the
 * session token as a bearer and X-Noa-Session naming the run, so the
 * server can tie usage to it. A 402 pauses the run: "Out of usage credit"
 * when none is left (the account is flagged; its Top up opens the
 * dashboard's Billing page), "Not enough usage credit" when some is left but
 * too little for the request.
 */
import { OutOfCreditError, type CreditShortfall, type JevLike } from "@noa/core";
import { hostedModel, SESSION_HEADER } from "@noa/shared";
import type { ApiBackend } from "./api-brain.js";
import { HOSTED_LABEL } from "./brain-resolver.js";
import type { CoreApi } from "./brains.js";

export interface HostedDeps {
  core: Pick<CoreApi, "createJev">;
  /** The signed-in session (null when signed out). */
  session(): { token: string; apiBase: string } | null;
  /** A request was refused for lack of credit: none left, or (`shortfall`) too little for it. */
  onOutOfCredit(shortfall?: CreditShortfall): void;
  /** A turn ended: the credit changed. */
  afterTurn?(): void;
  fetch?: typeof fetch;
}

/** The account server's Jev proxy (billed to the account). */
export const hostedJevEndpoint = (apiBase: string) => `${apiBase.replace(/\/+$/, "")}/v1/ai/jev`;

export function hostedBackend(deps: HostedDeps): ApiBackend {
  const backend: ApiBackend = {
    kind: "noa",
    label: HOSTED_LABEL,
    connect(settings, sessionId) {
      const s = deps.session();
      if (!s) throw new Error(`Not signed in: sign in to use ${HOSTED_LABEL}`);
      const base = s.apiBase.replace(/\/+$/, "");
      const headers = { [SESSION_HEADER]: sessionId };
      let jev: JevLike | null = null;
      if (settings.jevEnabled) {
        const inner = deps.core.createJev(s.token, { endpoint: hostedJevEndpoint(s.apiBase), headers, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
        jev = {
          async decide(input) {
            try {
              return await inner.decide(input);
            } catch (err) {
              if (err instanceof OutOfCreditError) deps.onOutOfCredit(err.shortfall);
              throw err;
            }
          },
        };
      }
      return {
        agent: {
          apiKey: s.token,
          model: hostedModel(settings.anthropicModel),
          baseUrl: `${base}/v1/ai`,
          auth: "bearer",
          headers,
          label: HOSTED_LABEL,
          onOutOfCredit: (info) => deps.onOutOfCredit(info.shortfall),
        },
        jev,
      };
    },
  };
  if (deps.afterTurn) backend.afterTurn = deps.afterTurn;
  return backend;
}
