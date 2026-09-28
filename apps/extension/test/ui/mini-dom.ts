/**
 * Just enough of a DOM for tests in node (the Markdown renderer, the
 * hands-free panel): elements, text nodes, fragments, attributes, children,
 * textContent, remove, replaceWith, hidden, dataset, classList, and an HTML
 * serializer that escapes like a browser.
 */
class MiniNode {
  parent: MiniElement | MiniFragment | null = null;
  remove(): void {
    if (!this.parent) return;
    const kids = this.parent.childNodes;
    kids.splice(kids.indexOf(this), 1);
    this.parent = null;
  }
  replaceWith(n: MiniNode): void {
    const p = this.parent;
    if (!p) return;
    n.remove();
    p.childNodes.splice(p.childNodes.indexOf(this), 1, n);
    n.parent = p;
    this.parent = null;
  }
  get isConnected(): boolean {
    return this.parent !== null;
  }
}

export class MiniText extends MiniNode {
  constructor(public data: string) {
    super();
  }
  get textContent(): string {
    return this.data;
  }
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => esc(s).replace(/"/g, "&quot;");

class Parent extends MiniNode {
  childNodes: MiniNode[] = [];
  prepend(...nodes: (MiniNode | string)[]): void {
    const rest = this.childNodes;
    this.childNodes = [];
    this.append(...nodes);
    this.childNodes.push(...rest);
  }
  append(...nodes: (MiniNode | string)[]): void {
    for (const n0 of nodes) {
      const n = typeof n0 === "string" ? new MiniText(n0) : n0;
      if (n instanceof MiniFragment) {
        for (const k of [...n.childNodes]) this.append(k);
        continue;
      }
      n.remove();
      n.parent = this as unknown as MiniElement;
      this.childNodes.push(n);
    }
  }
  get children(): MiniElement[] {
    return this.childNodes.filter((n): n is MiniElement => n instanceof MiniElement);
  }
  get textContent(): string {
    return this.childNodes.map((n) => (n as MiniText | MiniElement).textContent).join("");
  }
  set textContent(t: string) {
    this.childNodes = [];
    if (t) this.append(new MiniText(t));
  }
  /** Every descendant element with this tag (lower case). */
  all(tag?: string): MiniElement[] {
    const out: MiniElement[] = [];
    for (const k of this.children) {
      if (!tag || k.tagName === tag) out.push(k);
      out.push(...k.all(tag));
    }
    return out;
  }
  /** HTML assigned as innerHTML (an icon's SVG paths): kept as it is, not parsed, and not part of textContent. */
  rawHtml = "";
  get innerHTML(): string {
    return this.rawHtml || this.childNodes.map((n) => (n instanceof MiniText ? esc(n.data) : (n as MiniElement).outerHTML)).join("");
  }
  set innerHTML(html: string) {
    this.childNodes = [];
    this.rawHtml = html;
  }
}

export class MiniFragment extends Parent {}

export class MiniElement extends Parent {
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  private readonly listeners = new Map<string, ((e: unknown) => void)[]>();
  readonly classList = {
    contains: (c: string) => this.className.split(" ").includes(c),
    add: (c: string) => this.classList.toggle(c, true),
    remove: (c: string) => this.classList.toggle(c, false),
    toggle: (c: string, on = !this.classList.contains(c)) => {
      const rest = this.className.split(" ").filter((x) => x && x !== c);
      this.className = (on ? [...rest, c] : rest).join(" ");
      return on;
    },
  };
  constructor(readonly tagName: string) {
    super();
  }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  /** Runs the element's click listeners (there is no event propagation). */
  click(): void {
    for (const fn of this.listeners.get("click") ?? []) fn({ type: "click", target: this });
  }
  get hidden(): boolean {
    return this.attributes.has("hidden");
  }
  set hidden(on: boolean) {
    if (on) this.setAttribute("hidden", "");
    else this.attributes.delete("hidden");
  }
  get title(): string {
    return this.getAttribute("title") ?? "";
  }
  set title(v: string) {
    this.setAttribute("title", v);
  }
  setAttribute(k: string, v: string): void {
    this.attributes.set(k.toLowerCase(), String(v));
  }
  getAttribute(k: string): string | null {
    return this.attributes.get(k.toLowerCase()) ?? null;
  }
  get className(): string {
    return this.getAttribute("class") ?? "";
  }
  set className(v: string) {
    this.setAttribute("class", v);
  }
  get outerHTML(): string {
    const attrs = [...this.attributes].map(([k, v]) => ` ${k}="${escAttr(v)}"`).join("");
    const voids = new Set(["br", "hr"]);
    return voids.has(this.tagName) ? `<${this.tagName}${attrs}>` : `<${this.tagName}${attrs}>${this.innerHTML}</${this.tagName}>`;
  }
}

/** Installs the mini DOM as globalThis.document. */
export function installMiniDom(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new MiniElement(tag.toLowerCase()),
    createElementNS: (_ns: string, tag: string) => new MiniElement(tag.toLowerCase()),
    createTextNode: (t: string) => new MiniText(t),
    createDocumentFragment: () => new MiniFragment(),
    addEventListener: () => {},
  };
}

/** A detached element to render into. */
export const box = () => new MiniElement("div");
