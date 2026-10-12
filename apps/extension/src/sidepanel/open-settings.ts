/**
 * Opens the options page, optionally on one of its tabs (options.html#ai).
 * An options tab that is already open is reused: only its hash changes, so
 * the page switches tabs without reloading.
 */
import { showExtensionPage } from "../ui/extension-page.js";

export async function openSettings(tab?: string): Promise<void> {
  if (!tab) return void chrome.runtime.openOptionsPage();
  try {
    await showExtensionPage(`${chrome.runtime.getURL("options.html")}#${tab}`);
  } catch {
    await chrome.runtime.openOptionsPage();
  }
}
