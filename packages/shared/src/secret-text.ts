/**
 * Secrets in free text: what the Raw view's Copy / Download redact, and what
 * memory refuses to keep (memory.ts). Passwords the agent was handed are
 * caught where they are recorded (core's SecretRedactor); these patterns
 * catch keys, tokens and codes that reached a text some other way (a URL, a
 * page, a message). Browser-, Worker- and Node-safe.
 */

/** What a secret is replaced with. */
export const REDACTED_SECRET = "[redacted]";

/** Secrets in free text: API keys, bearer and session tokens, JWTs, key=value secrets in URLs, passwords, private keys. */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, REDACTED_SECRET],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED_SECRET],
  [/\bbt_[A-Za-z0-9_]{12,}/g, REDACTED_SECRET],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, REDACTED_SECRET],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED_SECRET],
  [/\b(?:ghp|gho|github_pat|xox[abpr])_[A-Za-z0-9_-]{10,}/g, REDACTED_SECRET],
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, REDACTED_SECRET],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED_SECRET],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED_SECRET}`],
  [/\b(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|token|session[_-]?token|session[_-]?id|sid|secret|client[_-]?secret|password|passwd|pwd|code|sig|signature|auth)=([^&\s"'#]+)/gi, `$1=${REDACTED_SECRET}`],
  [/\b(password|passwd|passphrase|pwd)(\s*[:=]\s*)("[^"]*"|\S+)/gi, `$1$2${REDACTED_SECRET}`],
  // A long unbroken run of token characters (a key or token of some other kind).
  [/[A-Za-z0-9+/_-]{64,}={0,2}/g, REDACTED_SECRET],
];

/** `text` with secrets replaced by REDACTED_SECRET. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, to] of SECRET_PATTERNS) out = out.replace(re, to);
  return out;
}

/**
 * Credentials said in words rather than shaped like a key: "password is hunter22", "the code is 482913",
 * "PIN: 1234", "backup codes 1234-5678". A value must follow the word; "Gmail asks for a 2FA code each
 * morning" says nothing secret.
 */
const CREDENTIAL_PHRASES: RegExp[] = [
  /\b(?:pass(?:word|wd|phrase|code)?|pwd|pin)\b\s*(?:is|was|=|:|->)\s*\S{3,}/i,
  /\b(?:code|codes|otp|pin|passcode|token|2fa|mfa)\b\s*(?:is|was|are|=|:|-)?\s*["'`]?\d[\d -]{2,}\d/i,
  /\b(?:seed|recovery|secret)\s+(?:phrase|words|key)\b\s*(?:is|was|=|:)/i,
];

/** A card-like number: 13 to 19 digits (spaces or dashes between) that pass the Luhn check. */
function hasCardNumber(text: string): boolean {
  for (const m of text.matchAll(/\b\d(?:[ -]?\d){12,18}\b/g)) {
    const digits = m[0].replace(/\D/g, "");
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
      sum += d;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

/**
 * Why `text` must not be kept (it holds a key, token, password, one-time code or card number), or null when it
 * holds none of those. Stricter than redactSecrets: memory keeps nothing that even looks like a credential.
 */
export function secretProblem(text: string): string | null {
  if (redactSecrets(text) !== text) return "it contains what looks like a key, token or password";
  if (CREDENTIAL_PHRASES.some((re) => re.test(text))) return "it contains what looks like a password, PIN or one-time code";
  if (hasCardNumber(text)) return "it contains what looks like a card number";
  return null;
}
