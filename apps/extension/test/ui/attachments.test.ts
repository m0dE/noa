import { describe, expect, it } from "vitest";
import { ATTACHMENT_LIMITS, fitImage, IMAGE_MAX_EDGE_PX, IMAGE_MAX_VISUAL_TOKENS, REDACTED_SECRET } from "@noa/shared";
import { AttachmentProblem, prepareAttachment, type DecodedImage, type ImageCodec } from "../../src/sidepanel/attachments/prepare.js";
import { AttachmentTray } from "../../src/sidepanel/attachments/tray.js";
import { typeBadge } from "../../src/sidepanel/attachments/view.js";

const MB = 1024 * 1024;

/** A codec that "decodes" any blob to width x height and encodes to `bytes(w, h, type, quality)` bytes. */
function fakeCodec(width: number, height: number, bytes: (w: number, h: number, type: string, quality?: number) => number = () => 1000): ImageCodec & { encoded: string[] } {
  const encoded: string[] = [];
  return {
    encoded,
    async decode(): Promise<DecodedImage> {
      return {
        width,
        height,
        async encode(w, h, type, quality) {
          encoded.push(`${w}x${h} ${type}${quality === undefined ? "" : ` q${quality}`}`);
          return new Blob([new Uint8Array(bytes(w, h, type, quality))], { type });
        },
        close() {},
      };
    },
  };
}

const file = (name: string, type: string, size = 10, body?: string) => new File([body ?? new Uint8Array(size)], name, { type });

describe("fitImage", () => {
  it("keeps an image within the edge and visual-token limits, aspect kept, never enlarged", () => {
    expect(fitImage(800, 600)).toEqual({ width: 800, height: 600 });
    const wide = fitImage(8000, 1000);
    expect(wide.width).toBeLessThanOrEqual(IMAGE_MAX_EDGE_PX);
    expect(Math.abs(wide.width / wide.height - 8)).toBeLessThan(0.05);
    for (const [w, h] of [[4000, 3000], [2000, 2000], [3840, 2160]] as const) {
      const f = fitImage(w, h);
      expect(Math.ceil(f.width / 28) * Math.ceil(f.height / 28)).toBeLessThanOrEqual(IMAGE_MAX_VISUAL_TOKENS);
      expect(Math.max(f.width, f.height)).toBeLessThanOrEqual(IMAGE_MAX_EDGE_PX);
    }
  });
});

describe("prepareAttachment", () => {
  it("keeps a small PNG as it is, with a thumbnail and its size", async () => {
    const codec = fakeCodec(800, 600);
    const p = await prepareAttachment(file("shot.png", "image/png", 5000), [], codec);
    expect(p).toMatchObject({ kind: "image", size: 5000, upload: { name: "shot.png", type: "image/png", width: 800, height: 600 } });
    expect(p.upload.thumb).toMatch(/^data:image\/jpeg;base64,/);
    // Only the thumbnail was drawn.
    expect(codec.encoded).toEqual(["96x72 image/jpeg q0.7"]);
  });

  it("downscales a large photo and re-encodes a format the model does not read as JPEG (renamed)", async () => {
    const codec = fakeCodec(6000, 4000);
    const p = await prepareAttachment(file("IMG_1.heic", "image/heic", 3 * MB), [], codec);
    const fit = fitImage(6000, 4000);
    expect(p.upload).toMatchObject({ name: "IMG_1.jpg", type: "image/jpeg", width: fit.width, height: fit.height });
    expect(codec.encoded[0]).toBe(`${fit.width}x${fit.height} image/jpeg`);
  });

  it("lowers JPEG quality until the image fits maxImageBytes, and refuses one that never does", async () => {
    const shrinking = fakeCodec(1000, 1000, (_w, _h, type, q) => (type === "image/png" ? 8 * MB : q && q <= 0.8 ? 1 * MB : 6 * MB));
    const ok = await prepareAttachment(file("big.png", "image/png", 9 * MB), [], shrinking);
    expect(ok.upload.type).toBe("image/jpeg");
    expect(ok.size).toBe(MB);
    const stubborn = fakeCodec(1000, 1000, (w) => (w > 100 ? 6 * MB : 100));
    await expect(prepareAttachment(file("huge.png", "image/png", 9 * MB), [], stubborn)).rejects.toThrow(/images can be at most 5 MB/);
  });

  it("says when an image cannot be read", async () => {
    const broken: ImageCodec = { decode: async () => Promise.reject(new Error("bad")) };
    await expect(prepareAttachment(file("x.png", "image/png"), [], broken)).rejects.toThrow(AttachmentProblem);
    await expect(prepareAttachment(file("x.png", "image/png"), [], broken)).rejects.toThrow(/cannot be read here/);
  });

  it("reads a text file, replaces what looks like a key, and warns about a password it cannot replace", async () => {
    const p = await prepareAttachment(file("notes.md", "text/markdown", 0, "Plan\napi_key=sk-ant-abcdefghijklmnop\nthe password is hunter22"), []);
    expect(p.kind).toBe("text");
    expect(p.upload.text).toContain(`api_key=${REDACTED_SECRET}`);
    expect(p.upload.note).toMatch(/replaced with \[redacted\]/);
    expect(p.warning).toEqual({ label: "may hold a secret", text: expect.stringMatching(/password, PIN or one-time code/) });
  });

  it("bounds a long text file and says how much was left out", async () => {
    const p = await prepareAttachment(file("log.txt", "text/plain", 0, "word ".repeat(ATTACHMENT_LIMITS.maxTextChars / 5 + 1)), []);
    expect(p.upload.text).toMatch(/\[cut here: 5 more characters not included\]$/);
  });

  it("refuses a file over the size limit or past the message's total", async () => {
    await expect(prepareAttachment(file("a.pdf", "application/pdf", 11 * MB), [])).rejects.toThrow(/files can be at most 10 MB/);
    await expect(prepareAttachment(file("b.pdf", "application/pdf", 2 * MB), [{ size: 9 * MB }])).rejects.toThrow(/10 MB together/);
  });

  it("says what is wrong with a .docx that is not one", async () => {
    await expect(prepareAttachment(file("x.docx", "", 0, "nope"), [])).rejects.toThrow(/x\.docx: not a Word document/);
  });
});

describe("AttachmentTray", () => {
  function tray(prepare?: ConstructorParameters<typeof AttachmentTray>[0]["prepare"]) {
    const problems: string[] = [];
    let changes = 0;
    const t = new AttachmentTray({
      prepare: prepare ?? (async (f) => ({ kind: "text", size: f.size, upload: { name: f.name, type: f.type, dataBase64: "" } })),
      onChange: () => void changes++,
      onProblem: (text) => problems.push(text),
    });
    return { t, problems, changes: () => changes };
  }

  it("prepares files in order, then hands out their uploads; removing works, and only what was sent leaves", async () => {
    const { t } = tray();
    t.add([file("a.txt", "text/plain"), file("b.txt", "text/plain")]);
    expect(t.items().map((i) => i.status)).toEqual(["preparing", "preparing"]);
    expect(t.busy).toBe(true);
    expect((await t.batch()).uploads.map((u) => u.name)).toEqual(["a.txt", "b.txt"]);
    expect(t.busy).toBe(false);
    t.remove(t.items()[0]!.id);
    expect((await t.batch()).uploads.map((u) => u.name)).toEqual(["b.txt"]);
    // Sent: the files that went out leave; one added meanwhile stays.
    const batch = await t.batch();
    t.add([file("c.txt", "text/plain")]);
    batch.sent();
    expect(t.items().map((i) => i.name)).toEqual(["c.txt"]);
  });

  it("refuses files past maxFiles at once, and drops a file whose preparation fails (saying why)", async () => {
    const { t, problems } = tray(async (f) => {
      if (f.name === "bad.png") throw new AttachmentProblem("bad.png: this image format cannot be read here");
      return { kind: "text", size: 1, upload: { name: f.name, type: "text/plain", dataBase64: "" } };
    });
    t.add(Array.from({ length: ATTACHMENT_LIMITS.maxFiles + 2 }, (_, i) => file(i === 0 ? "bad.png" : `f${i}.txt`, "text/plain")));
    expect(problems).toEqual([`At most ${ATTACHMENT_LIMITS.maxFiles} files per message: 2 not added`]);
    expect(t.count).toBe(ATTACHMENT_LIMITS.maxFiles);
    await t.batch();
    expect(problems.at(-1)).toBe("bad.png: this image format cannot be read here");
    expect(t.count).toBe(ATTACHMENT_LIMITS.maxFiles - 1);
  });

  it("counts what is ready toward the message's size limit", async () => {
    const helds: number[][] = [];
    const { t } = tray(async (f, held) => {
      helds.push(held.map((h) => h.size));
      return { kind: "file", size: f.size, upload: { name: f.name, type: "", dataBase64: "" } };
    });
    t.add([file("a.bin", "", 3), file("b.bin", "", 4)]);
    await t.batch();
    expect(helds).toEqual([[], [3]]);
  });

  it("a file removed while it is prepared is not added back", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    const { t } = tray(async (f) => {
      await gate;
      return { kind: "text", size: 1, upload: { name: f.name, type: "text/plain", dataBase64: "" } };
    });
    t.add([file("a.txt", "text/plain")]);
    t.remove(t.items()[0]!.id);
    finish();
    expect((await t.batch()).uploads).toEqual([]);
  });
});

describe("typeBadge", () => {
  it("shows the file's extension, else its kind", () => {
    expect(typeBadge("report.pdf", "pdf")).toBe("PDF");
    expect(typeBadge("notes", "docx")).toBe("DOC");
    expect(typeBadge("clip", "file")).toBe("FILE");
  });
});
