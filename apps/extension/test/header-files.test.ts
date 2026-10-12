import { describe, expect, it } from "vitest";
import { hasCloudFiles } from "../src/sidepanel/header.js";
import type { AccountView } from "../src/ui-protocol.js";

const base: AccountView = { signedIn: true, signInConfigured: true, apiBase: "https://api.test", dashboardUrl: "https://api.test/", billingUrl: "https://api.test/billing", filesUrl: "https://api.test/files" };
const plan = (id: "free" | "plus") => ({ id, status: id === "free" ? ("none" as const) : ("active" as const), currentPeriodEnd: null, cancelAtPeriodEnd: false });

describe("the header's files button", () => {
  it("opens the cloud files when signed in on a plan that has them; otherwise the Noa folder", () => {
    expect(hasCloudFiles({ ...base, plan: plan("plus") } as AccountView)).toBe(true);
    expect(hasCloudFiles({ ...base, plan: plan("free") } as AccountView)).toBe(false);
    expect(hasCloudFiles({ ...base, signedIn: false, plan: plan("plus") } as AccountView)).toBe(false);
    expect(hasCloudFiles(undefined)).toBe(false);
  });
});
