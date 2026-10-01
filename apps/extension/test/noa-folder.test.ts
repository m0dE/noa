import { beforeEach, describe, expect, it } from "vitest";
import { installChromeFake, type ChromeFake } from "./chrome-fake.js";
import { NoaFolder, README_TEXT } from "../src/engine/noa-folder.js";

let chrome: ChromeFake;
beforeEach(() => {
  chrome = installChromeFake();
});

describe("NoaFolder", () => {
  it("writes the README into Downloads/Noa once and shows it in the file manager, with the download UI off", async () => {
    const folder = new NoaFolder();
    expect(await folder.open()).toBe("C:\\Users\\me\\Downloads\\Noa");
    expect(chrome.downloads.items).toHaveLength(1);
    const [readme] = chrome.downloads.items;
    expect(readme!.filename).toBe("C:\\Users\\me\\Downloads\\Noa\\README.txt");
    expect(decodeURIComponent(readme!.url.replace(/^data:text\/plain;charset=utf-8,/, ""))).toBe(README_TEXT);
    expect(chrome.downloads.shown).toEqual([readme!.id]);
    expect(chrome.downloads.uiCalls).toEqual([false, true]);

    // Again: the same README, not a second one.
    await folder.open();
    expect(chrome.downloads.items).toHaveLength(1);
    expect(chrome.downloads.shown).toEqual([readme!.id, readme!.id]);
  });

  it("writes the README again when the file was deleted or the download history cleared", async () => {
    const folder = new NoaFolder();
    await folder.open();
    chrome.downloads.items[0]!.removed = true;
    await folder.open();
    expect(chrome.downloads.items).toHaveLength(2);
    chrome.downloads.items[1]!.erased = true;
    await folder.open();
    expect(chrome.downloads.items).toHaveLength(3);
    expect(chrome.downloads.shown).toEqual([1, 2, 3]);
  });

  it("says why when the folder cannot be written", async () => {
    chrome.downloads.behavior = () => "interrupted";
    await expect(new NoaFolder().open()).rejects.toThrow(/Could not create the Noa folder in Downloads: .*SERVER_FORBIDDEN/);
    expect(chrome.downloads.shown).toEqual([]);
    expect(chrome.downloads.uiEnabled).toBe(true);
  });
});
