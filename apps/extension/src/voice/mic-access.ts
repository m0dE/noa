/**
 * Microphone permission. Chrome cannot show its permission prompt in a side
 * panel, so the panel checks the permission and, when it is not granted yet,
 * opens mic-permission.html in a tab to ask. Permissions belong to the origin
 * (chrome-extension://<id>), so a grant on that page covers the side panel too.
 */
import { showExtensionPage } from "../ui/extension-page.js";

/** The extension page that asks for the microphone (static/mic-permission.html). */
export const MIC_PERMISSION_PAGE = "mic-permission.html";

export type MicPermission = "granted" | "prompt" | "denied";

type PermissionsLike = Pick<Permissions, "query">;

/** The microphone permission of this origin ("prompt" when the browser cannot say). */
export async function micPermission(permissions: PermissionsLike | undefined = globalThis.navigator?.permissions): Promise<MicPermission> {
  if (!permissions) return "prompt";
  try {
    return (await permissions.query({ name: "microphone" as PermissionName })).state;
  } catch {
    return "prompt";
  }
}

/**
 * Calls `onChange` when the permission changes (e.g. granted on the
 * permission page while the panel waits). Returns an unsubscribe function.
 */
export async function watchMicPermission(
  onChange: (state: MicPermission) => void,
  permissions: PermissionsLike | undefined = globalThis.navigator?.permissions,
): Promise<() => void> {
  if (!permissions) return () => undefined;
  let status: PermissionStatus;
  try {
    status = await permissions.query({ name: "microphone" as PermissionName });
  } catch {
    return () => undefined;
  }
  const listener = () => onChange(status.state);
  status.addEventListener("change", listener);
  return () => status.removeEventListener("change", listener);
}

export interface MicAccessDeps {
  permission(): Promise<MicPermission>;
  /** Opens (or focuses) the permission page. */
  openPermissionPage(): Promise<void>;
}

export function browserMicAccessDeps(): MicAccessDeps {
  return {
    permission: () => micPermission(),
    openPermissionPage: () => showExtensionPage(chrome.runtime.getURL(MIC_PERMISSION_PAGE)),
  };
}
