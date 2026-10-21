import { describe, expect, it } from "vitest";
import { ExtensionSettings } from "@noa/shared";
import { storageView } from "../src/options/storage-view.js";
import type { AccountView, StorageSummary } from "../src/ui-protocol.js";

const settings = ExtensionSettings.parse({});
const signedIn = (plan: string | null): AccountView => ({
  signedIn: true,
  signInConfigured: true,
  apiBase: "https://app.noa.bot",
  dashboardUrl: "https://app.noa.bot/",
  billingUrl: "https://app.noa.bot/billing",
  filesUrl: "https://app.noa.bot/files",
  user: { email: "a@b.test", name: "A", pictureUrl: null },
  ...(plan ? { plan: { id: plan, status: "active", currentPeriodEnd: null, cancelAtPeriodEnd: false } as NonNullable<AccountView["plan"]> } : {}),
});
const sum = (o: Partial<StorageSummary> = {}): StorageSummary => ({ folder: "/home/me/Downloads/Noa", localFiles: 12, cloud: { files: 34, usedBytes: 5 * 1024 * 1024, quotaBytes: 2 * 1024 ** 3, locked: false }, ...o });

describe("Settings > Storage", () => {
  it("signed in on a plan with cloud files: usage, a meter, browse; the folder with its count", () => {
    const v = storageView({ settings, account: signedIn("starter") }, sum());
    expect(v).toMatchObject({ cloud: "5 MB of 2 GB used · 34 files", browse: true, action: null, tone: "", folder: "/home/me/Downloads/Noa · 12 files" });
    expect(v.fraction).toBeCloseTo(5 / 2048);
    expect(storageView({ settings, account: signedIn("starter") }, sum({ cloud: { files: 9, usedBytes: 1.9 * 1024 ** 3, quotaBytes: 2 * 1024 ** 3, locked: false } })).tone).toBe("warn");
  });

  it("where files go: cloud by default on a plan with cloud files; the user's choice; this computer without the cloud", () => {
    const checked = (v: ReturnType<typeof storageView>) => v.where.filter((o) => o.checked).map((o) => o.id);
    const paid = storageView({ settings, account: signedIn("starter") }, sum());
    expect(checked(paid)).toEqual(["cloud"]);
    expect(paid.where.map((o) => [o.id, o.disabled])).toEqual([["cloud", false], ["local", false], ["both", false]]);
    expect(paid.whereNote).toBe("Cloud is the default for your plan.");
    expect(checked(storageView({ settings: { ...settings, fileStorage: "both" }, account: signedIn("starter") }, sum()))).toEqual(["both"]);
    expect(checked(storageView({ settings: { ...settings, fileStorage: "local" }, account: signedIn("starter") }, sum()))).toEqual(["local"]);
    // Free, or signed out: this computer, the cloud choices off; a cloud choice made before waits for a plan.
    const free = storageView({ settings: { ...settings, fileStorage: "cloud" }, account: signedIn(null) }, sum({ cloud: { files: 0, usedBytes: 0, quotaBytes: 100, locked: true } }));
    expect(checked(free)).toEqual(["local"]);
    expect(free.where.map((o) => [o.id, o.disabled])).toEqual([["cloud", true], ["local", false], ["both", true]]);
    expect(free.whereNote).toMatch(/^You chose Cloud: files are kept on this computer until you are signed in on a plan with cloud files/);
    const out = storageView({ settings, account: { signedIn: false, signInConfigured: true, apiBase: "", dashboardUrl: "", billingUrl: "", filesUrl: "" } }, sum({ cloud: null }));
    expect(checked(out)).toEqual(["local"]);
    expect(out.whereNote).toMatch(/^Sign in on a plan with cloud files/);
    // The cloud files could not be loaded: the plan still says the cloud is there.
    expect(checked(storageView({ settings, account: signedIn("starter") }, sum({ cloud: null, cloudError: "offline" })))).toEqual(["cloud"]);
  });

  it("signed out: sign in; free plan: see plans, and files kept before can still be browsed", () => {
    expect(storageView({ settings, account: { signedIn: false, signInConfigured: true, apiBase: "", dashboardUrl: "", billingUrl: "", filesUrl: "" } }, sum({ cloud: null }))).toMatchObject({ action: "sign-in", browse: false });
    const free = storageView({ settings, account: signedIn(null) }, sum({ cloud: { files: 2, usedBytes: 10, quotaBytes: 100, locked: true } }));
    expect(free).toMatchObject({ action: "plans", browse: true });
    expect(free.cloud).toMatch(/paid plan\. The 2 files kept before stay/);
    expect(storageView({ settings, account: signedIn(null) }, sum({ cloud: { files: 0, usedBytes: 0, quotaBytes: 100, locked: true } })).browse).toBe(false);
  });

  it("the account server's answer decides (locked), whatever the cached plan says; without it, the plan's cloud files feature", () => {
    // The plan was cached before it ended: the server says locked.
    expect(storageView({ settings, account: signedIn("starter") }, sum({ cloud: { files: 0, usedBytes: 0, quotaBytes: 100, locked: true } })).action).toBe("plans");
    // A plan the cache does not know yet: the server says it has cloud files.
    expect(storageView({ settings, account: signedIn(null) }, sum()).action).toBeNull();
    expect(storageView({ settings, account: signedIn(null) }, sum({ cloud: null })).action).toBe("plans");
  });

  it("says when the cloud files could not be loaded, the helper is missing, or the folder is not found", () => {
    expect(storageView({ settings, account: signedIn("starter") }, sum({ cloud: null, cloudError: "offline" }))).toMatchObject({ cloud: "Your cloud files could not be loaded: offline", tone: "warn" });
    expect(storageView({ settings, account: signedIn("starter") }, sum({ localFiles: null })).folder).toMatch(/helper is not connected/);
    expect(storageView({ settings, account: signedIn("starter") }, sum({ folder: null, folderError: "downloads blocked" })).folder).toBe("The folder could not be found: downloads blocked");
    expect(storageView({ settings, account: signedIn("starter") }, null).cloud).toBe("Loading your cloud files…");
  });
});
