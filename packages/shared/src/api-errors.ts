/** Reading the API's error bodies (every client: extension, dashboard). */
import { HOSTED_AI_UNAVAILABLE_CODE, OUT_OF_CREDIT_CODE, PLAN_REQUIRED } from "./billing.js";

/** Machine codes an error body may carry in `error`; the human text is then in `message`. */
const ERROR_CODES: readonly string[] = [OUT_OF_CREDIT_CODE, PLAN_REQUIRED, HOSTED_AI_UNAVAILABLE_CODE];

/** Whether `v` is one of the machine codes an error body may carry in `error`. */
export function isApiErrorCode(v: unknown): boolean {
  return typeof v === "string" && ERROR_CODES.includes(v);
}

/** The server's own words from an error body: `message` first, then `error` (a bare machine code is skipped). Null when neither says anything. */
export function serverMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  for (const key of ["message", "error"]) {
    const v = b[key];
    if (typeof v === "string" && v.trim() && !isApiErrorCode(v)) return v.trim();
  }
  return null;
}
