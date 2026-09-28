/** The service worker's log lines, tagged so they stand out in the extension's console. */
export function logger(scope?: string): (message: string) => void {
  const tag = scope ? `[noa] ${scope}:` : "[noa]";
  return (message) => console.log(tag, message);
}
