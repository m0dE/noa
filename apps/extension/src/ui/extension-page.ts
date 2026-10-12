/** Opening one of the extension's own pages in a tab. */

/**
 * Brings the tab that already shows this page (any hash) to the front,
 * loading `url` in it when that differs, or opens it in a new tab.
 */
export async function showExtensionPage(url: string): Promise<void> {
  const page = url.split("#")[0]!;
  const open = (await chrome.tabs.query({})).find((t) => t.url?.startsWith(page));
  if (open?.id === undefined) {
    await chrome.tabs.create({ url });
    return;
  }
  await chrome.tabs.update(open.id, open.url === url ? { active: true } : { url, active: true });
  if (open.windowId !== undefined) await chrome.windows.update(open.windowId, { focused: true });
}
