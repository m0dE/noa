/**
 * Values baked in at build time by build.mjs (esbuild `define`). Tests and
 * the UI harness build without them and get the defaults.
 */
declare const __NOA_GOOGLE_CLIENT_ID__: string | undefined;
declare const __NOA_HELPER_CODE__: string | undefined;

/**
 * The helper code id this extension was built with (apps/helper/code-id.mjs); "dev" in tests and the harness. Settings
 * on a phone (phone-panel/settings.ts) are built without it: they set the computer's extension's before loading.
 */
export const HELPER_CODE: string =
  typeof __NOA_HELPER_CODE__ === "string" ? __NOA_HELPER_CODE__ : ((globalThis as { __noaHelperCode?: string }).__noaHelperCode ?? "dev");

/**
 * Google OAuth client ID for "Log In" (a Web application client whose
 * redirect URI is https://<extension id>.chromiumapp.org/). Empty: sign-in
 * uses the account server's (GET /v1/config); see apps/extension/README.md.
 */
export const GOOGLE_CLIENT_ID: string =
  typeof __NOA_GOOGLE_CLIENT_ID__ === "string" ? __NOA_GOOGLE_CLIENT_ID__.trim() : "";
