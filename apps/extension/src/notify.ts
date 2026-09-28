import { errorMessage } from "@noa/shared";
import { logger } from "./log.js";

const log = logger("notify");

/** Show a Chrome notification with the extension icon. Never throws. */
export async function notify(title: string, message: string): Promise<void> {
  try {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: `Noa: ${title}`,
      message: message.slice(0, 500),
      priority: 1,
    });
  } catch (err) {
    log(`notification failed: ${errorMessage(err)}`);
  }
}
