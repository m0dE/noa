/**
 * `host.js --check`: what the installer and the "why does it not start" command print. It runs through the same
 * launcher Chrome starts, so a launcher or node that cannot reach host.js shows its own error instead of this line.
 */
export const CHECK_FLAG = "--check";
/** The first word of a helper that started; the installer looks for it. */
export const CHECK_OK = "noa-helper-ok";

export function checkReport(o: { version: string; code: string; nodePath: string; nodeVersion: string; claudePath: string | null; logDir: string }): string {
  return [
    `${CHECK_OK} v${o.version} code=${o.code}`,
    `  node: ${o.nodePath} (${o.nodeVersion})`,
    `  Claude Code: ${o.claudePath ?? "not found"}`,
    `  logs: ${o.logDir}`,
  ].join("\n");
}
