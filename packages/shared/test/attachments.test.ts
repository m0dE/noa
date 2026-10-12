import { describe, expect, it } from "vitest";
import { ATTACHMENT_LIMITS, attachmentKind, attachmentRefusal, boundText } from "../src/attachments.js";

describe("attachments", () => {
  it("tells kinds apart by media type, else by name", () => {
    expect(attachmentKind("a.png", "image/png")).toBe("image");
    expect(attachmentKind("scan", "application/pdf")).toBe("pdf");
    expect(attachmentKind("scan.pdf", "")).toBe("pdf");
    expect(attachmentKind("memo.docx", "")).toBe("docx");
    expect(attachmentKind("data.csv", "text/csv")).toBe("text");
    expect(attachmentKind("config.yaml", "application/octet-stream")).toBe("text");
    expect(attachmentKind("x.json", "application/json")).toBe("text");
    expect(attachmentKind("clip.mp4", "video/mp4")).toBe("file");
  });

  it("refuses past the count, per-file and per-message limits, naming the file", () => {
    const MB = 1024 * 1024;
    expect(attachmentRefusal({ name: "a.png", size: 4 * MB, kind: "image" }, [])).toBeNull();
    expect(attachmentRefusal({ name: "a.png", size: 6 * MB, kind: "image" }, [])).toBe("a.png is 6 MB; images can be at most 5 MB");
    expect(attachmentRefusal({ name: "b.pdf", size: 11 * MB, kind: "pdf" }, [])).toBe("b.pdf is 11 MB; files can be at most 10 MB");
    expect(attachmentRefusal({ name: "c.txt", size: 2 * MB, kind: "text" }, [{ size: 9 * MB }])).toMatch(/at most 10 MB together/);
    const full = Array.from({ length: ATTACHMENT_LIMITS.maxFiles }, () => ({ size: 1 }));
    expect(attachmentRefusal({ name: "d.txt", size: 1, kind: "text" }, full)).toBe("At most 10 files per message");
  });

  it("bounds text, saying how much was cut", () => {
    expect(boundText("abc", 5)).toBe("abc");
    expect(boundText("abcdef", 4)).toBe("abcd\n[cut here: 2 more characters not included]");
  });
});
