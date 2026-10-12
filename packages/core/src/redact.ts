/**
 * Keeps secrets the agent was handed (get_credential passwords) out of
 * everything that is shown or stored: Activity events, run logs, live.log.
 * The model itself still gets them; only what leaves the agent is redacted.
 */
import { REDACTED_SECRET } from "@noa/shared";

export const REDACTED = REDACTED_SECRET;

/**
 * Shorter secrets are not redacted: replacing every occurrence of a
 * two-letter string would garble the whole log while protecting little.
 */
export const MIN_SECRET_CHARS = 4;

/** A copy of `value` with `fn` applied to every string in it (objects and arrays are walked; other values are kept). */
export function mapStrings<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === "string") return fn(value) as T;
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = mapStrings(v, fn);
    return out as T;
  }
  return value;
}

export class SecretRedactor {
  private readonly secrets = new Set<string>();

  /** Remembers a secret; from now on redact() hides it. */
  add(secret: string): void {
    if (secret.length >= MIN_SECRET_CHARS) this.secrets.add(secret);
  }

  /** `value` with every known secret replaced by REDACTED (the value itself while none is known). */
  redact<T>(value: T): T {
    if (this.secrets.size === 0) return value;
    return mapStrings(value, (s) => {
      let out = s;
      for (const secret of this.secrets) if (out.includes(secret)) out = out.split(secret).join(REDACTED);
      return out;
    });
  }
}
