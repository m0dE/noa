/**
 * How attached files look: chips in the input box (thumbnail or type badge,
 * name, size, a remove button, preparing and warning states), and the strip of
 * thumbnails and file chips on the message they were sent with.
 */
import { formatBytes, plural, type AttachmentKind, type AttachmentRef } from "@noa/shared";
import { h } from "../../ui/dom.js";
import type { TrayItem } from "./tray.js";

/** The short type label on a file's badge: its extension, else its kind. */
export function typeBadge(name: string, kind: AttachmentKind): string {
  const ext = /\.([A-Za-z0-9]{1,5})$/.exec(name)?.[1];
  if (ext) return ext.toUpperCase();
  return kind === "pdf" ? "PDF" : kind === "docx" ? "DOC" : kind === "text" ? "TXT" : "FILE";
}

function badge(name: string, kind: AttachmentKind): HTMLElement {
  return h("span.att-badge", { "data-kind": kind, "aria-hidden": "true" }, typeBadge(name, kind));
}

/**
 * The input box's chips, one per file. onRemove: its remove button (keyboard: the focus moves to the next chip's
 * button, else to `afterLast`).
 */
export function renderTrayChips(list: HTMLElement, items: readonly TrayItem[], onRemove: (id: string) => void, afterLast: () => void): void {
  list.hidden = items.length === 0;
  list.setAttribute("aria-label", items.length ? `${plural(items.length, "file")} attached` : "No files attached");
  list.replaceChildren(
    ...items.map((item, i) => {
      const thumb = item.prepared?.upload.thumb;
      const warning = item.prepared?.warning;
      const preparing = item.status === "preparing";
      const remove = h(
        "button.att-remove",
        {
          type: "button",
          "aria-label": `Remove ${item.name}`,
          title: "Remove",
          onclick: () => {
            const next = items[i + 1]?.id;
            onRemove(item.id);
            const target = next ? list.querySelector<HTMLButtonElement>(`[data-id="${next}"] .att-remove`) : null;
            if (target) target.focus();
            else afterLast();
          },
        },
        "×",
      );
      return h(
        "li.att-chip",
        {
          "data-id": item.id,
          class: [preparing ? "preparing" : "", warning ? "warn" : ""].filter(Boolean).join(" ") || null,
          title: [item.name, preparing ? "Preparing…" : formatBytes(item.size), warning?.text ?? ""].filter(Boolean).join("\n"),
        },
        thumb ? h("img.att-thumb", { src: thumb, alt: "" }) : badge(item.name, item.kind),
        h(
          "span.att-text",
          null,
          h("span.att-name", null, item.name),
          h("span.att-meta", null, preparing ? "Preparing…" : warning ? `${formatBytes(item.size)} · ${warning.label}` : formatBytes(item.size)),
        ),
        warning ? h("span.sr-only", null, warning.text) : null,
        remove,
      );
    }),
  );
}

/** The files a message was sent with: image thumbnails, then chips for other files. Null when none. */
export function renderSentFiles(refs: readonly AttachmentRef[] | undefined): HTMLElement | null {
  if (!refs?.length) return null;
  return h(
    "div.ev-attachments",
    { role: "list", "aria-label": `${plural(refs.length, "file")} sent with this message` },
    ...refs.map((r) => {
      const title = [r.name, r.width && r.height ? `${r.width}×${r.height}` : "", formatBytes(r.size), r.note ?? ""].filter(Boolean).join(" · ");
      if (r.thumb) return h("span.att-sent.image", { role: "listitem", title }, h("img", { src: r.thumb, alt: r.name, loading: "lazy" }));
      return h("span.att-sent", { role: "listitem", title }, badge(r.name, r.kind), h("span.att-name", null, r.name));
    }),
  );
}
