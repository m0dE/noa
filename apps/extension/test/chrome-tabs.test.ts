import { beforeEach, describe, expect, it } from "vitest";
import { installChromeFake, type ChromeFake } from "./chrome-fake.js";
import { addToGroup, agentGroupIds, agentGroupOf, applyGroupLook, removeAgentTabs, TAB_GROUP_TITLE } from "../src/chrome-tabs.js";

let chrome: ChromeFake;
let windowId: number;

beforeEach(async () => {
  chrome = installChromeFake();
  const win = await chrome.windows.create({ url: "https://news.test/", focused: true, type: "normal" });
  windowId = win.id;
});

const newTab = async () => (await chrome.tabs.create({ windowId, url: "about:blank", active: false })).id;
const groupOf = (tabId: number) => chrome.tabGroups.byId.get(chrome.tabs.byId.get(tabId)!.groupId);

describe("the agent's tab group", () => {
  it("is titled with the brand as users see it", async () => {
    const tab = await newTab();
    await addToGroup(tab);
    expect(TAB_GROUP_TITLE).toBe("Noa");
    expect(groupOf(tab)?.title).toBe("Noa");
  });

  it("is found by its id once its title shows a status or the user renamed it", async () => {
    const first = await newTab();
    await addToGroup(first);
    const groupId = groupOf(first)!.id;
    await applyGroupLook(groupId, { title: "Noa · working", color: "purple" });
    const second = await newTab();
    await addToGroup(second);
    expect(groupOf(second)?.id).toBe(groupId);

    await chrome.tabGroups.update(groupId, { title: "My robot" });
    const third = await newTab();
    await addToGroup(third);
    expect(groupOf(third)?.id).toBe(groupId);
    expect(chrome.tabGroups.byId.size).toBe(1);
    expect(await agentGroupOf(third)).toBe(groupId);
    expect(await agentGroupIds()).toEqual([groupId]);
    expect(await removeAgentTabs([third])).toBe(1);
  });

  it("a group of the user's is not the agent's", async () => {
    const tab = await newTab();
    await chrome.tabs.group({ tabIds: [tab], createProperties: { windowId } });
    expect(await agentGroupOf(tab)).toBeNull();
    expect(await removeAgentTabs([tab])).toBe(0);
  });
});

describe("the group's look", () => {
  const grouped = async () => {
    const tab = await newTab();
    await addToGroup(tab);
    return groupOf(tab)!.id;
  };

  it("starts grey and titled Noa, then shows each look it is given", async () => {
    const groupId = await grouped();
    expect(chrome.tabGroups.byId.get(groupId)).toMatchObject({ title: "Noa", color: "grey" });
    await applyGroupLook(groupId, { title: "Noa · working", color: "purple" });
    expect(chrome.tabGroups.byId.get(groupId)).toMatchObject({ title: "Noa · working", color: "purple" });
    await applyGroupLook(groupId, { title: "Noa", color: "grey" });
    expect(chrome.tabGroups.byId.get(groupId)).toMatchObject({ title: "Noa", color: "grey" });
  });

  it("a title the user gave stays theirs; the colour still follows the state", async () => {
    const groupId = await grouped();
    await chrome.tabGroups.update(groupId, { title: "Bot tabs" });
    await applyGroupLook(groupId, { title: "Noa · working", color: "purple" });
    expect(chrome.tabGroups.byId.get(groupId)).toMatchObject({ title: "Bot tabs", color: "purple" });
    await applyGroupLook(groupId, { title: "Noa", color: "grey" });
    expect(chrome.tabGroups.byId.get(groupId)).toMatchObject({ title: "Bot tabs", color: "grey" });
  });

  it("a colour the user picked stays theirs; the title still follows the state", async () => {
    const groupId = await grouped();
    await chrome.tabGroups.update(groupId, { color: "green" });
    await applyGroupLook(groupId, { title: "Noa · needs you", color: "yellow" });
    expect(chrome.tabGroups.byId.get(groupId)).toMatchObject({ title: "Noa · needs you", color: "green" });
  });

  it("never touches whether the group is collapsed, and skips a group that is gone", async () => {
    const groupId = await grouped();
    Object.assign(chrome.tabGroups.byId.get(groupId)!, { collapsed: true });
    await applyGroupLook(groupId, { title: "Noa · working", color: "purple" });
    expect(chrome.tabGroups.byId.get(groupId)).toMatchObject({ collapsed: true });
    chrome.tabGroups.byId.delete(groupId);
    await expect(applyGroupLook(groupId, { title: "Noa", color: "grey" })).resolves.toBeUndefined();
    expect(await agentGroupIds()).toEqual([]);
  });
});
