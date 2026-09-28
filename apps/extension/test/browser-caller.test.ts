import { describe, expect, it } from "vitest";
import { createBrowserCaller, type DriverLike, type VaultLike } from "../src/engine/browser-caller.js";

/** A browser caller whose current tab is on `url`, with one saved login for every site asked. */
function callerOn(url: string) {
  const asked: string[] = [];
  const driver = { currentUrl: async () => ({ url }) } as unknown as DriverLike;
  const vault: VaultLike = {
    getCredential: async (site) => {
      asked.push(site);
      return { found: true, username: "ada", password: "s3cret" };
    },
  };
  return { asked, getCredential: (site: string) => createBrowserCaller(driver, vault).call("vault.getCredential", { site }) };
}

describe("vault.getCredential answers only for the current tab's site", () => {
  it("a page on evil.test gets nothing for bank.test: the vault is not even asked", async () => {
    const t = callerOn("https://evil.test/login");
    await expect(t.getCredential("bank.test")).rejects.toThrow(/only for the site of the current tab \(evil\.test\)/);
    // Not by a look-alike host either.
    await expect(t.getCredential("bank.test.evil.test.com")).rejects.toThrow(/current tab/);
    expect(t.asked).toEqual([]);
  });

  it("the tab's own site, or another host of it, gets its login", async () => {
    const t = callerOn("https://login.bank.test/signin");
    await expect(t.getCredential("bank.test")).resolves.toMatchObject({ found: true, username: "ada" });
    await expect(t.getCredential("https://www.bank.test/")).resolves.toMatchObject({ found: true });
    expect(t.asked).toEqual(["bank.test", "https://www.bank.test/"]);
  });

  it("a tab on no site (a blank tab) gets nothing", async () => {
    await expect(callerOn("about:blank").getCredential("bank.test")).rejects.toThrow(/current tab/);
  });
});
