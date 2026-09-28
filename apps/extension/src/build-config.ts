/**
 * Values baked in at build time by build.mjs (esbuild `define`). Tests and
 * the UI harness build without them and get the defaults.
 */
declare const __NOA_GOOGLE_CLIENT_ID__: string | undefined;

/**
 * Google OAuth client ID for "Log In" (a Web application client whose
 * redirect URI is https://<extension id>.chromiumapp.org/). Empty: sign-in
 * uses the account server's (GET /v1/config); see apps/extension/README.md.
 */
export const GOOGLE_CLIENT_ID: string =
  typeof __NOA_GOOGLE_CLIENT_ID__ === "string" ? __NOA_GOOGLE_CLIENT_ID__.trim() : "";
