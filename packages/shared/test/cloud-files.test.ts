import { describe, expect, it } from "vitest";
import { CloudFolder, cloudFolderName, MAX_CLOUD_FOLDER_CHARS } from "../src/cloud-files.js";

describe("cloud folders", () => {
  it("are the top, images, or one folder name of letters, digits, spaces, - and _", () => {
    for (const ok of ["", "images", "invoices", "Tax 2026", "été", "a_b-c"]) expect(CloudFolder.safeParse(ok).success, ok).toBe(true);
    for (const bad of ["a/b", "../x", " lead", "trail ", "x".repeat(MAX_CLOUD_FOLDER_CHARS + 1), "a.b"]) expect(CloudFolder.safeParse(bad).success, bad).toBe(false);
  });

  it("cloudFolderName makes any name one CloudFolder accepts", () => {
    expect(cloudFolderName("Invoices/2026")).toBe("Invoices 2026");
    expect(cloudFolderName("  ../receipts  ")).toBe("receipts");
    expect(cloudFolderName(undefined)).toBe("");
    expect(cloudFolderName("///")).toBe("");
    for (const raw of ["Invoices/2026", "x".repeat(80), " a . b ", "x".repeat(59) + " y"]) expect(CloudFolder.safeParse(cloudFolderName(raw)).success, raw).toBe(true);
  });
});
