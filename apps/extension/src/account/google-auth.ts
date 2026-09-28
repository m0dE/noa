/**
 * Google sign-in for the extension: chrome.identity.launchWebAuthFlow on
 * Google's OAuth endpoint with response_type=id_token. The ID token comes
 * back in the redirect URL's fragment; its nonce and state must match what
 * we sent, and its audience must be our client ID. The API verifies the
 * signature itself (POST /v1/auth/google).
 */

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
/** Shown when there is no Google client ID at all: none built in and no account server to ask. */
export const SIGN_IN_NOT_SET_UP = "Google sign-in isn't available in this version of Noa";
/** Chrome refused a second sign-in window ("Only one web auth flow is allowed at a time"). */
export const SIGN_IN_WINDOW_OPEN = "A Google sign-in window is already open (it may be behind this window). Finish or close it, then sign in again.";

export class SignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignInError";
  }
}

export function buildGoogleAuthUrl(p: { clientId: string; redirectUri: string; nonce: string; state: string }): string {
  const q = new URLSearchParams({
    client_id: p.clientId,
    response_type: "id_token",
    scope: "openid email profile",
    redirect_uri: p.redirectUri,
    nonce: p.nonce,
    state: p.state,
    prompt: "select_account",
  });
  return `${GOOGLE_AUTH_URL}?${q.toString()}`;
}

/** Reads id_token/state (or error) from the redirect URL's fragment (or query, for errors). */
export function parseAuthRedirect(url: string): { idToken: string; state: string } | { error: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { error: "Google returned an unreadable address" };
  }
  const params = new URLSearchParams(u.hash.replace(/^#/, ""));
  for (const [k, v] of u.searchParams) if (!params.has(k)) params.set(k, v);
  const error = params.get("error");
  if (error) return { error: error === "access_denied" ? "Sign-in was cancelled" : `Google sign-in failed: ${error}` };
  const idToken = params.get("id_token");
  if (!idToken) return { error: "Google did not return an ID token" };
  return { idToken, state: params.get("state") ?? "" };
}

function base64UrlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** The claims of a JWT, unverified (the server checks the signature). */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) throw new SignInError("The ID token is malformed");
  try {
    const claims = JSON.parse(base64UrlDecode(part)) as unknown;
    if (!claims || typeof claims !== "object") throw new Error("not an object");
    return claims as Record<string, unknown>;
  } catch {
    throw new SignInError("The ID token is malformed");
  }
}

export function randomToken(bytes = 16): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface GoogleSignInDeps {
  clientId: string;
  /** chrome.identity.getRedirectURL(): https://<extension id>.chromiumapp.org/ */
  redirectUri: string;
  /** chrome.identity.launchWebAuthFlow({ url, interactive: true }): the final redirect URL. */
  launch(url: string): Promise<string | undefined>;
  random?: () => string;
}

/** Runs the Google flow and returns a checked ID token (nonce, state and audience match). */
export async function googleIdToken(deps: GoogleSignInDeps): Promise<string> {
  if (!deps.clientId) throw new SignInError(SIGN_IN_NOT_SET_UP);
  const random = deps.random ?? (() => randomToken());
  const nonce = random();
  const state = random();
  let redirect: string | undefined;
  try {
    redirect = await deps.launch(buildGoogleAuthUrl({ clientId: deps.clientId, redirectUri: deps.redirectUri, nonce, state }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Closing the Google window rejects with "The user did not approve access."
    if (/did not approve|cancel/i.test(msg)) throw new SignInError("Sign-in was cancelled");
    // Chrome allows one sign-in window at a time (e.g. one left open behind the browser).
    if (/only one web auth flow/i.test(msg)) throw new SignInError(SIGN_IN_WINDOW_OPEN);
    throw new SignInError(`Google sign-in failed: ${msg}`);
  }
  if (!redirect) throw new SignInError("Sign-in was cancelled");
  const parsed = parseAuthRedirect(redirect);
  if ("error" in parsed) throw new SignInError(parsed.error);
  if (parsed.state !== state) throw new SignInError("Sign-in answer did not match the request (state); try again");
  const claims = decodeJwtPayload(parsed.idToken);
  if (claims.nonce !== nonce) throw new SignInError("Sign-in answer did not match the request (nonce); try again");
  const aud = claims.aud;
  if (aud !== deps.clientId && !(Array.isArray(aud) && aud.includes(deps.clientId))) {
    throw new SignInError("The ID token was issued for another app");
  }
  return parsed.idToken;
}
