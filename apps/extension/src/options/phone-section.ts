/**
 * Settings > Account > Your phone (docs/MOBILE.md): pair a phone with a QR code, see the paired phones (online or
 * not), unpair one. The work is the background's phone link (phone-link/link.ts); this page asks it with
 * phone.view / phone.pair / phone.unpair and redraws when it says phone.changed.
 */
import qrcode from "qrcode-generator";
import type { PhoneLinkView } from "../phone-link/link.js";
import { $, busy, h, showError } from "../ui/dom.js";

async function ask<T>(msg: { type: string; id?: string }): Promise<T> {
  const res = (await chrome.runtime.sendMessage(msg)) as T & { error?: string };
  if (res && typeof res === "object" && "error" in res && res.error) throw new Error(res.error);
  return res;
}

/** The QR code of `text` as an SVG element (the library writes the SVG; the text is our own address). */
export function qrSvg(text: string): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

export function initPhoneSection(): void {
  const list = $<HTMLUListElement>("phone-list");
  const qrWrap = $("phone-qr-wrap");
  const qrBox = $("phone-qr");
  const link = $<HTMLAnchorElement>("phone-url");
  const pairBtn = $<HTMLButtonElement>("phone-pair");
  const msg = $("phone-msg");
  let shownUrl = "";

  const draw = (v: PhoneLinkView): void => {
    $("phone-box").hidden = !v.signedIn;
    $("h-phone").hidden = !v.signedIn;
    list.replaceChildren(
      ...v.phones.map((p) =>
        h(
          "li",
          null,
          h("span", { class: `dot${p.online ? " on" : ""}`, title: p.online ? "Connected" : "Not connected now" }),
          h("span", null, p.name, p.online ? "" : h("small.muted", null, " · not connected now")),
          h("span.spacer"),
          h("button.small.ghost", { type: "button", onclick: (e: Event) => void busy(e.currentTarget as HTMLButtonElement, () => unpair(p.id), msg) }, "Unpair"),
        ),
      ),
    );
    list.hidden = !v.phones.length;
    const url = v.pairing?.url ?? "";
    if (url !== shownUrl) {
      shownUrl = url;
      qrBox.innerHTML = url ? qrSvg(url) : "";
      link.href = url || "#";
    }
    qrWrap.hidden = !url;
    pairBtn.textContent = v.phones.length ? "Pair another phone" : "Pair a phone";
  };

  const refresh = async (): Promise<void> => draw(await ask<PhoneLinkView>({ type: "phone.view" }));
  const unpair = async (id: string): Promise<void> => {
    await ask({ type: "phone.unpair", id });
    await refresh();
  };

  pairBtn.addEventListener("click", () =>
    void busy(
      pairBtn,
      async () => {
        await ask({ type: "phone.pair" });
        await refresh();
      },
      msg,
    ),
  );
  link.addEventListener("click", (e) => {
    e.preventDefault();
    if (!shownUrl) return;
    void navigator.clipboard.writeText(shownUrl).then(
      () => (msg.textContent = "Link copied. Open it on your phone."),
      (err: unknown) => showError(msg, err),
    );
  });
  chrome.runtime.onMessage.addListener((m: { type?: string }) => {
    if (m?.type === "phone.changed") void refresh().catch(() => {});
  });
  // Signed in or out elsewhere on this page.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.account || changes.phoneLink)) void refresh().catch(() => {});
  });
  void refresh().catch((err: unknown) => showError(msg, err));
}
