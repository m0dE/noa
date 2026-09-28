/** Small chrome.tabs / chrome.windows helpers for the agent's tabs. */

export const TAB_GROUP_TITLE = "Noa";

/** Status titles look like "Noa · working" (control-indicator.ts). */
export const TAB_GROUP_STATUS_SEPARATOR = " · ";

/** A title this extension gives its group: the brand or a status title. */
function isAgentGroupTitle(title: string | undefined): boolean {
  return title === TAB_GROUP_TITLE || !!title?.startsWith(TAB_GROUP_TITLE + TAB_GROUP_STATUS_SEPARATOR);
}

/** A tab group colour ("grey", "purple", ...; chrome.tabGroups.Color's values). */
export type GroupColor = `${chrome.tabGroups.Color}`;

/** How the group looks: its title and colour. */
export interface GroupLook {
  title: string;
  color: GroupColor;
}

/**
 * The agent's groups, by id (chrome.storage.session: gone with the browser session, like group ids). Each keeps the
 * title and colour this extension set last; null once the user changed it (renamed or recoloured the group): that
 * part is theirs from then on.
 */
const GROUPS_KEY = "agentGroups";
type Managed = { title: string | null; color: GroupColor | null };
type GroupRecords = Record<string, Managed>;

async function groupRecords(): Promise<GroupRecords> {
  return ((await chrome.storage.session.get(GROUPS_KEY))[GROUPS_KEY] as GroupRecords | undefined) ?? {};
}

/** Changes to the records run one at a time (a run's grouping and the indicator's looks overlap). */
let recordsChain: Promise<unknown> = Promise.resolve();

function changeGroupRecords<T>(change: (records: GroupRecords) => Promise<{ save: boolean; value: T }>): Promise<T> {
  const next = recordsChain.then(async () => {
    const records = await groupRecords();
    const { save, value } = await change(records);
    if (save) await chrome.storage.session.set({ [GROUPS_KEY]: records });
    return value;
  });
  recordsChain = next.catch(() => undefined);
  return next;
}

function registerGroup(group: Pick<chrome.tabGroups.TabGroup, "id" | "title" | "color">): Promise<void> {
  return changeGroupRecords(async (records) => {
    if (records[group.id]) return { save: false, value: undefined };
    records[group.id] = { title: group.title ?? "", color: group.color };
    return { save: true, value: undefined };
  });
}

/** The agent's group: one this extension made (by id, whatever its title now), or one titled like it (older versions). */
async function isAgentGroup(group: Pick<chrome.tabGroups.TabGroup, "id" | "title">): Promise<boolean> {
  return !!(await groupRecords())[group.id] || isAgentGroupTitle(group.title);
}

/** The agent's group the tab is in, or null (no group, a group of the user's, or Chrome without tab groups). */
export async function agentGroupOf(tabId: number): Promise<number | null> {
  if (!chrome.tabGroups) return null;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const groupId = tab?.groupId ?? -1;
  if (groupId === -1) return null;
  const group = await chrome.tabGroups.get(groupId).catch(() => null);
  return group && (await isAgentGroup(group)) ? group.id : null;
}

/** The agent's groups that still exist. */
export async function agentGroupIds(): Promise<number[]> {
  if (!chrome.tabGroups) return [];
  return changeGroupRecords(async (records) => {
    const known = Object.keys(records).map(Number);
    const alive: number[] = [];
    for (const id of known) {
      if (await chrome.tabGroups.get(id).then(() => true, () => false)) alive.push(id);
      else delete records[id];
    }
    return { save: alive.length < known.length, value: alive };
  });
}

/**
 * Gives an agent group this look. A title or colour the user changed since this extension set it stays theirs (never
 * set again for that group); collapsing is never touched. Best effort: a group that is gone is skipped.
 */
export async function applyGroupLook(groupId: number, look: GroupLook): Promise<void> {
  const update = await changeGroupRecords(async (records) => {
    const group = await chrome.tabGroups?.get(groupId).catch(() => null);
    if (!group) return { save: false, value: null };
    const managed: Managed = records[groupId] ?? { title: group.title ?? "", color: group.color };
    if (managed.title !== null && (group.title ?? "") !== managed.title) managed.title = null;
    if (managed.color !== null && group.color !== managed.color) managed.color = null;
    const props: chrome.tabGroups.UpdateProperties = {};
    if (managed.title !== null && managed.title !== look.title) props.title = managed.title = look.title;
    if (managed.color !== null && managed.color !== look.color) props.color = (managed.color = look.color) as chrome.tabGroups.Color;
    records[groupId] = managed;
    return { save: true, value: props };
  });
  if (update && Object.keys(update).length) await chrome.tabGroups.update(groupId, update).catch(() => undefined);
}

/** How a group of the agent looks while it does nothing. */
export const IDLE_GROUP_LOOK: GroupLook = { title: TAB_GROUP_TITLE, color: "grey" };

/**
 * Puts the tabs (all in one window) in the window's Noa tab group (creating it if needed), like Claude's own
 * "Claude" group. The group is found by the id it was made with (its title shows a status and the user may rename
 * it), else by its title (older versions). Best effort: never blocks a task.
 */
export async function addToGroup(tabIds: number | number[]): Promise<void> {
  try {
    if (!chrome.tabGroups || !chrome.tabs.group) return;
    const list = Array.isArray(tabIds) ? tabIds : [tabIds];
    if (!list.length) return;
    const ids = list as [number, ...number[]];
    const tab = await chrome.tabs.get(ids[0]);
    const current = tab.groupId ?? -1;
    if (ids.length === 1 && current !== -1 && (await agentGroupOf(ids[0])) !== null) return;
    const inWindow = await chrome.tabGroups.query({ windowId: tab.windowId });
    const records = await groupRecords();
    const existing = inWindow.find((g) => records[g.id]) ?? inWindow.find((g) => isAgentGroupTitle(g.title));
    if (existing) {
      await chrome.tabs.group({ groupId: existing.id, tabIds: ids });
      await registerGroup(existing);
      return;
    }
    const groupId = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId: tab.windowId } });
    await chrome.tabGroups.update(groupId, { title: IDLE_GROUP_LOOK.title, color: IDLE_GROUP_LOOK.color as chrome.tabGroups.Color });
    await registerGroup({ id: groupId, ...IDLE_GROUP_LOOK });
  } catch {
    /* grouping is cosmetic */
  }
}

export async function tabExists(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

/** Closes tabs, ignoring ones that are already gone. */
export async function removeTabs(tabIds: number[]): Promise<void> {
  await Promise.all(tabIds.map((id) => chrome.tabs.remove(id).catch(() => undefined)));
}

/**
 * Closes the agent's tabs the user has not taken over: a tab the user is
 * looking at (active in its window) or moved out of the Noa group
 * is theirs now and stays. remove: how they are closed (a remover may keep a
 * tab whose page asks "Leave site?"). Returns how many it closed.
 */
export async function removeAgentTabs(tabIds: number[], remove: (tabIds: number[]) => Promise<unknown> = removeTabs): Promise<number> {
  const left: number[] = [];
  for (const id of tabIds) {
    const tab = await chrome.tabs.get(id).catch(() => null);
    if (tab && !tab.active && (await inAgentGroup(tab))) left.push(id);
  }
  await remove(left);
  return left.length;
}

/** In the Noa group (always true where Chrome has no tab groups). */
async function inAgentGroup(tab: chrome.tabs.Tab): Promise<boolean> {
  if (!chrome.tabGroups) return true;
  return tab.id !== undefined && (await agentGroupOf(tab.id)) !== null;
}

export async function lastNormalWindow(): Promise<chrome.windows.Window | null> {
  try {
    return await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
  } catch {
    return null;
  }
}

/** A new window with a blank tab; focused: false for runs the user did not just start. */
export async function createWindowTab(focused = true): Promise<number> {
  const win = await chrome.windows.create({ url: "about:blank", focused, type: "normal" });
  const tabId = win?.tabs?.[0]?.id;
  if (tabId === undefined) throw new Error("Could not open a browser window for the agent");
  return tabId;
}

/** The tab finished loading (nothing pending). */
export function isTabLoaded(tab: Pick<chrome.tabs.Tab, "status" | "pendingUrl">): boolean {
  return tab.status === "complete" && !tab.pendingUrl;
}

/** The address a tab shows, or the one it is loading ("" when neither is known). */
export function tabUrl(tab: Pick<chrome.tabs.Tab, "url" | "pendingUrl">): string {
  return tab.url || tab.pendingUrl || "";
}

export function mustId(tab: chrome.tabs.Tab | undefined): number {
  if (tab?.id === undefined) throw new Error("Could not open a tab for the agent");
  return tab.id;
}
