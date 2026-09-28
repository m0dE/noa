/** The Driver on a fresh chrome fake, as the driver tests set it up. */
import type { Sleep } from "@noa/shared";
import { installChromeFake, type ChromeFake } from "./chrome-fake.js";
import { AgentTab } from "../src/agent-tab.js";
import { Cdp } from "../src/cdp.js";
import { Driver } from "../src/driver.js";

export interface DriverHarness {
  chrome: ChromeFake;
  cdp: Cdp;
  agent: AgentTab;
  driver: Driver;
}

/** sleep: the driver's waits (default: none). */
export function driverHarness(sleep: Sleep = async () => {}): DriverHarness {
  const chrome = installChromeFake();
  const cdp = new Cdp();
  const agent = new AgentTab();
  return { chrome, cdp, agent, driver: new Driver(cdp, agent, { sleep }) };
}

/** A focused normal window whose active tab shows `url`. */
export async function userWindow(chrome: ChromeFake, url: string): Promise<{ windowId: number; tabId: number }> {
  const win = await chrome.windows.create({ url, focused: true, type: "normal" });
  return { windowId: win.id, tabId: win.tabs[0]!.id };
}

/** The user's tab at `url`, taken as the run's tab (a one-off run). */
export async function runInUserTab(h: DriverHarness, url: string): Promise<{ windowId: number; tabId: number }> {
  const tab = await userWindow(h.chrome, url);
  await h.agent.prepare("current-tab");
  return tab;
}

/** Elements of a page the fakes show as drawn: more than NEARLY_EMPTY's, so reads never wait for it to draw (readWhenDrawn). */
export const DRAWN = [
  { index: 1, role: "link", name: "Home" },
  { index: 2, role: "link", name: "Inbox" },
  { index: 3, role: "button", name: "Compose" },
];
