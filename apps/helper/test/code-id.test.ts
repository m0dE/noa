import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain .mjs build module
import { helperCodeId } from "../code-id.mjs";
import { helperInstall } from "../src/config.js";

describe("the helper's code id and install", () => {
  it("is the same on every computation, whatever the current directory", async () => {
    const a = await helperCodeId();
    const cwd = process.cwd();
    process.chdir("/");
    try {
      expect(await helperCodeId()).toBe(a);
    } finally {
      process.chdir(cwd);
    }
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });
  it("run from the repo, the helper is a checkout (its update is pnpm build)", () => {
    expect(helperInstall("/nowhere/noa")).toBe("checkout");
  });
});
