import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { DEFAULT_MODEL, helperInstallerUrl, noaHome, noaModelName, parseArgs } from "../src/setup.mjs";

describe("noa-local-llm", () => {
  it("reads its options; refuses unknown ones and bad ids", () => {
    expect(parseArgs([])).toEqual({ model: DEFAULT_MODEL, extensionId: null, helperCode: null, skipHelper: false, help: false });
    expect(parseArgs(["--model", "hermes3:8b", "--extension-id", "bfffghamekalimhllmeeigmmcoghhfke", "--helper-code", "b0c7280e863a", "--skip-helper"])).toEqual({
      model: "hermes3:8b",
      extensionId: "bfffghamekalimhllmeeigmmcoghhfke",
      helperCode: "b0c7280e863a",
      skipHelper: true,
      help: false,
    });
    expect(() => parseArgs(["--modle", "x"])).toThrow(/Unknown option --modle/);
    expect(() => parseArgs(["--model"])).toThrow(/--model needs a value/);
    expect(() => parseArgs(["--extension-id", "abc"])).toThrow(/Not a Chrome extension id/);
    expect(() => parseArgs(["--helper-code", "; rm -rf"])).toThrow(/Not a helper code/);
  });

  it("Noa's folder where the helper looks (NOA_HOME, else the system's app data folder)", () => {
    expect(noaHome({ NOA_HOME: "/x" }, "linux")).toBe("/x");
    expect(noaHome({ LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "win32")).toBe(join("C:\\Users\\a\\AppData\\Local", "noa"));
    expect(noaHome({ XDG_DATA_HOME: "/d" }, "linux")).toBe(join("/d", "noa"));
    expect(noaHome({}, "darwin")).toMatch(/Library[\\/]Application Support[\\/]noa$/);
  });

  it("the helper's installer for the system and version; the model's copy with Noa's context", () => {
    expect(helperInstallerUrl("linux", null)).toBe("https://noa.bot/helper/install.sh");
    expect(helperInstallerUrl("darwin", "b0c7280e863a")).toBe("https://noa.bot/helper/b0c7280e863a/install.sh");
    expect(helperInstallerUrl("win32", null)).toBe("https://noa.bot/helper/install.ps1");
    expect(noaModelName("qwen3:8b")).toBe("noa-qwen3:8b");
    expect(noaModelName("hf.co/org/model:q4")).toBe("noa-model:q4");
  });
});
