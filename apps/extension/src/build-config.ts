/**
 * Values baked in at build time by build.mjs (esbuild `define`). Tests and
 * the UI harness build without them and get the defaults.
 */
declare const __NOA_GOOGLE_CLIENT_ID__: string | undefined;
declare const __NOA_HELPER_CODE__: string | undefined;

/** The helper code id this extension was built with (apps/helper/code-id.mjs); "dev" in tests and the harness. */
export const HELPER_CODE: string = typeof __NOA_HELPER_CODE__ === "string" ? __NOA_HELPER_CODE__ : "dev";

/**
 * Google OAuth client ID for "Log In" (a Web application client whose
 * redirect URI is https://<extension id>.chromiumapp.org/). Empty: sign-in
 * uses the account server's (GET /v1/config); see apps/extension/README.md.
 */
export const GOOGLE_CLIENT_ID: string =
  typeof __NOA_GOOGLE_CLIENT_ID__ === "string" ? __NOA_GOOGLE_CLIENT_ID__.trim() : "";
