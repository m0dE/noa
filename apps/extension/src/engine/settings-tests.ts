/** The options page's Test buttons. Each resolves { ok, detail } and never throws. */
import { ANTHROPIC_API_BASE, ANTHROPIC_API_VERSION, errorMessage, type ExtensionSettings, type PageSnapshot } from "@noa/shared";
import type { JevLike } from "@noa/core";
import type { BrainStatus } from "../ui-protocol.js";
import { CLOUD_JEV, HOSTED_SIGN_IN } from "./brain-resolver.js";
import type { CoreApi } from "./brains.js";
import { hostedJevEndpoint } from "./hosted-brain.js";

export interface TestResult {
  ok: boolean;
  detail: string;
}

export const ANTHROPIC_MODELS_URL = `${ANTHROPIC_API_BASE}/models`;

/** GET /v1/models with the stored key: proves the key works without spending tokens. */
export async function testClaude(settings: ExtensionSettings, fetchFn: typeof fetch = (i, init) => fetch(i, init)): Promise<TestResult> {
  if (!settings.anthropicApiKey) return { ok: false, detail: "No Claude API key set" };
  let res: Response;
  try {
    res = await fetchFn(ANTHROPIC_MODELS_URL, {
      method: "GET",
      headers: {
        "x-api-key": settings.anthropicApiKey,
        "anthropic-version": ANTHROPIC_API_VERSION,
        "anthropic-dangerous-direct-browser-access": "true",
      },
    });
  } catch (err) {
    return { ok: false, detail: `Cannot reach ${new URL(ANTHROPIC_API_BASE).host}: ${errorMessage(err)}` };
  }
  const body = (await res.json().catch(() => null)) as { data?: { id?: string }[]; error?: { message?: string } } | null;
  if (res.status === 401 || res.status === 403) return { ok: false, detail: `Claude API key rejected (HTTP ${res.status})` };
  if (!res.ok) return { ok: false, detail: `Claude API answered HTTP ${res.status}${body?.error?.message ? `: ${body.error.message}` : ""}` };
  const ids = (body?.data ?? []).map((m) => m.id).filter((x): x is string => !!x);
  const model = settings.anthropicModel;
  const modelNote = ids.length === 0 ? "" : ids.includes(model) ? `; model ${model} is available` : `; model ${model} is not in the list for this key`;
  return { ok: true, detail: `Key accepted${ids.length ? ` (${ids.length} models)` : ""}${modelNote}` };
}

const TEST_SNAPSHOT: PageSnapshot = {
  url: "https://example.com/form",
  title: "Test form",
  text: "Newsletter. Enter your email and press Subscribe.",
  elements: [
    { index: 0, tag: "input", role: "textbox", name: "Email", type: "email", inViewport: true },
    { index: 1, tag: "button", role: "button", name: "Subscribe", inViewport: true },
  ],
  truncated: false,
};

export interface TestJevDeps {
  core: Pick<CoreApi, "createJev">;
  /** The signed-in account's session (Noa AI's Jev), or null. */
  hosted: { token: string; apiBase: string } | null;
  fetch?: typeof fetch;
}

/**
 * One tiny Jev decision on a two-element page, with the Jev the resolved
 * brain would use (BrainStatus.jevSource): the key set here, or Noa's cloud
 * Jev through the account server. The helper's own key (local Claude Code)
 * cannot be reached from here.
 */
export async function testJev(settings: ExtensionSettings, brain: Pick<BrainStatus, "jevSource">, deps: TestJevDeps): Promise<TestResult> {
  const fetchOpt = deps.fetch ? { fetch: deps.fetch } : undefined;
  switch (brain.jevSource) {
    case "cloud":
      if (!deps.hosted) return { ok: false, detail: HOSTED_SIGN_IN };
      return askJev(CLOUD_JEV, deps.core.createJev(deps.hosted.token, { endpoint: hostedJevEndpoint(deps.hosted.apiBase), ...fetchOpt }));
    case "key":
      return askJev("Jev", deps.core.createJev(settings.jevApiKey, fetchOpt));
    case "helper":
      return { ok: false, detail: "Local Claude Code uses the helper's own Jev key, which this test cannot reach" };
    default:
      return { ok: false, detail: "No Jev: set a Jev key, or log in to use Noa's cloud Jev" };
  }
}

async function askJev(name: string, jev: JevLike): Promise<TestResult> {
  const started = Date.now();
  try {
    const d = await jev.decide({ goal: "click the Subscribe button", snapshot: TEST_SNAPSHOT });
    const ms = Date.now() - started;
    const target = d.index === null ? "no element" : `element ${d.index}`;
    const right = d.operation === "click" && d.index === 1;
    return {
      ok: true,
      detail: `${name} answered in ${ms} ms: ${d.operation} ${target} (confidence ${d.confidence.toFixed(2)})${right ? "" : " (unexpected choice)"}`,
    };
  } catch (err) {
    return { ok: false, detail: `${name} test failed: ${errorMessage(err)}` };
  }
}
