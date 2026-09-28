/** File names that are safe to write on any system (Windows included): task media, chat attachments. */

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
};

/** A file name that is safe on Windows and inside the downloads folder. */
export function safeFileName(name: string, type = ""): string {
  let n = (name.split(/[\\/]/).pop() ?? "")
    .replace(/[<>:"|?*\u0000-\u001f]/g, "_")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "");
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n)) n = `_${n}`;
  if (!n) n = "file";
  if (!/\.[a-z0-9]{1,8}$/i.test(n)) n += EXT_BY_TYPE[type.split(";")[0]!.trim().toLowerCase()] ?? "";
  if (n.length > 120) {
    const ext = /\.[a-z0-9]{1,8}$/i.exec(n)?.[0] ?? "";
    n = n.slice(0, 120 - ext.length) + ext;
  }
  return n;
}

/** Makes names unique within one batch: a.png, a-2.png, ... */
export function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  return names.map((n) => {
    let out = n;
    const dot = n.lastIndexOf(".");
    const stem = dot > 0 ? n.slice(0, dot) : n;
    const ext = dot > 0 ? n.slice(dot) : "";
    for (let i = 2; seen.has(out.toLowerCase()); i++) out = `${stem}-${i}${ext}`;
    seen.add(out.toLowerCase());
    return out;
  });
}
