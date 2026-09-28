import { beforeAll, describe, expect, it } from "vitest";
import { box, installMiniDom, type MiniElement } from "./mini-dom.js";
import { MarkdownView, closeDangling, parseBlocks, safeUrl } from "../../src/sidepanel/markdown.js";

beforeAll(installMiniDom);

/** Rendered HTML (as a browser would serialize the DOM the renderer built). */
function md(text: string, streaming = false): string {
  return tree(text, streaming).innerHTML;
}
function tree(text: string, streaming = false): MiniElement {
  const b = box();
  new MarkdownView(b as unknown as HTMLElement).update(text, streaming);
  return b;
}

describe("Markdown: blocks", () => {
  it("paragraphs, and single newlines as line breaks", () => {
    expect(md("First line\nsecond line\n\nNext paragraph.")).toBe("<p>First line<br>second line</p><p>Next paragraph.</p>");
  });

  it("headings", () => {
    expect(md("# One\n## Two ##\n### Three\nText")).toBe("<h1>One</h1><h2>Two</h2><h3>Three</h3><p>Text</p>");
    expect(md("#not a heading")).toBe("<p>#not a heading</p>");
  });

  it("fenced code keeps its text exactly, with the language", () => {
    expect(md("```sh\nzip -r a.zip . -x '*.git*'\n  <b>&amp;</b>\n```\nafter")).toBe(
      "<pre><code data-lang=\"sh\">zip -r a.zip . -x '*.git*'\n  &lt;b&gt;&amp;amp;&lt;/b&gt;\n</code></pre><p>after</p>".replace("\n</code>", "</code>"),
    );
    expect(md("~~~\n**not bold**\n~~~")).toBe("<pre><code>**not bold**</code></pre>");
  });

  it("unordered and ordered lists, with a nested list and lazy continuation", () => {
    expect(md("- a\n- b\n  - b1\n  - b2\n- c")).toBe("<ul><li>a</li><li>b<ul><li>b1</li><li>b2</li></ul></li><li>c</li></ul>");
    expect(md("1. one\n2. two\n   more of two\n3. three")).toBe("<ol><li>one</li><li>two<br>more of two</li><li>three</li></ol>");
    expect(md("3. three\n4. four")).toBe('<ol start="3"><li>three</li><li>four</li></ol>');
    expect(md("1. **Jordan** (Example Corp)\n   - Asks about **Friday**.\n2. Sam")).toBe(
      "<ol><li><strong>Jordan</strong> (Example Corp)<ul><li>Asks about <strong>Friday</strong>.</li></ul></li><li>Sam</li></ol>",
    );
  });

  it("a list right after a paragraph line, and a loose list with blank lines between items", () => {
    expect(md("Items:\n- a\n- b")).toBe("<p>Items:</p><ul><li>a</li><li>b</li></ul>");
    expect(md("- a\n\n- b\n\nAfter")).toBe("<ul><li>a</li><li>b</li></ul><p>After</p>");
  });

  it("blockquotes (with Markdown inside) and horizontal rules", () => {
    expect(md("> Review takes **days**.\n> Second line\n\n---\n\nEnd")).toBe("<blockquote><p>Review takes <strong>days</strong>.<br>Second line</p></blockquote><hr><p>End</p>");
  });

  it("pipe tables, in a scroll wrapper", () => {
    expect(md("| Name | Qty |\n|:-----|----:|\n| **a** | 1 |\n| b | 2 |")).toBe(
      '<div class="md-table"><table><thead><tr><th style="text-align: left">Name</th><th style="text-align: right">Qty</th></tr></thead>' +
        '<tbody><tr><td style="text-align: left"><strong>a</strong></td><td style="text-align: right">1</td></tr><tr><td style="text-align: left">b</td><td style="text-align: right">2</td></tr></tbody></table></div>',
    );
  });

  it("the whole answer from the user's report: lists, bold and line breaks are no longer one paragraph", () => {
    const answer = "Here's how:\n\n**1. Prepare**\n- Zip the folder\n- Add icons\n\n**2. Upload**\n1. Open the dashboard\n2. Pay the fee";
    const t = tree(answer);
    expect(t.children.map((c) => c.tagName)).toEqual(["p", "p", "ul", "p", "ol"]);
    expect(t.textContent).not.toContain("**");
  });
});

describe("Markdown: inline", () => {
  it("bold, italic, strike, code spans", () => {
    expect(md("**b** *i* _i2_ ~~s~~ `c` __b2__")).toBe("<p><strong>b</strong> <em>i</em> <em>i2</em> <del>s</del> <code>c</code> <strong>b2</strong></p>");
    expect(md("**bold with *italic* inside**")).toBe("<p><strong>bold with <em>italic</em> inside</strong></p>");
    expect(md("`a ** b` and ``x ` y``")).toBe("<p><code>a ** b</code> and <code>x ` y</code></p>");
  });

  it("leaves lone marks, snake_case and arithmetic alone", () => {
    expect(md("2 * 3 * 4, snake_case_name, a ** b")).toBe("<p>2 * 3 * 4, snake_case_name, a ** b</p>");
    expect(md("\\*not italic\\*")).toBe("<p>*not italic*</p>");
  });

  it("links: http(s) only, new tab, noopener", () => {
    expect(md("[Dashboard](https://chrome.google.com/webstore/devconsole)")).toBe(
      '<p><a href="https://chrome.google.com/webstore/devconsole" target="_blank" rel="noopener noreferrer">Dashboard</a></p>',
    );
    expect(md("see https://example.com/a_(b)_c. and <https://ex.com/x>")).toBe(
      '<p>see <a href="https://example.com/a_(b)_c" target="_blank" rel="noopener noreferrer">https://example.com/a_(b)_c</a>. and <a href="https://ex.com/x" target="_blank" rel="noopener noreferrer">https://ex.com/x</a></p>',
    );
    expect(md("(https://example.com/x)")).toBe('<p>(<a href="https://example.com/x" target="_blank" rel="noopener noreferrer">https://example.com/x</a>)</p>');
  });

  // Regression: a bare scheme with nothing linkable after it ("https://" at the end of a streamed
  // chunk, or followed by a space, backtick or angle bracket) threw
  // "TypeError: Cannot read properties of null (reading '0')" from the autolink branch.
  it("a bare http(s):// with no host is plain text, not a crash", () => {
    for (const s of ["https://", "Open http://", "see https:// now", "https://`x`", "http://<b>", "HTTPS://\nnext"]) {
      expect(() => md(s)).not.toThrow();
      expect(() => md(s, true)).not.toThrow();
    }
    expect(md("Open https://")).toBe("<p>Open https://</p>");
    expect(md("see https:// now")).toBe("<p>see https:// now</p>");
    expect(md("Visit https://", true)).toBe("<p>Visit https://</p>");
  });
});

describe("Markdown: untrusted text stays text", () => {
  const hasTag = (t: MiniElement, tag: string) => t.all(tag).length > 0;
  it("HTML and <script> are shown as text, never as elements", () => {
    const t = tree('<script>alert(1)</script>\n<img src=x onerror="alert(2)">\n**<b>x</b>**\n```\n<script>y</script>\n```');
    for (const tag of ["script", "img", "b", "iframe"]) expect(hasTag(t, tag)).toBe(false);
    expect(t.textContent).toContain("<script>alert(1)</script>");
    expect(t.innerHTML).toContain("&lt;img src=x onerror=\"alert(2)\"&gt;");
    expect(t.innerHTML).not.toMatch(/<(script|img|iframe)/);
  });

  it("javascript:, data:, vbscript:, relative and protocol-relative links are not links", () => {
    for (const bad of ["javascript:alert(1)", "JavaScript:alert(1)", " javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:x", "/relative", "//evil.example.com", "java\tscript:alert(1)"]) {
      const t = tree(`[click me](${bad})`);
      expect(t.all("a")).toEqual([]);
    }
    expect(tree("<javascript:alert(1)>").all("a")).toEqual([]);
    expect(tree("javascript:alert(1)").all("a")).toEqual([]);
    expect(safeUrl("https://ok.example.com/x?a=1")).toBe("https://ok.example.com/x?a=1");
    expect(safeUrl("ftp://example.com")).toBeNull();
  });

  it("a link text with HTML stays text; an href cannot break out of its attribute", () => {
    const t = tree('[<img src=x onerror=alert(1)>](https://example.com/"onmouseover="alert(1))');
    expect(t.all("img")).toEqual([]);
    for (const a of t.all("a")) {
      expect(a.getAttribute("href")!.startsWith("https://example.com/")).toBe(true);
      expect([...a.attributes.keys()].sort()).toEqual(["href", "rel", "target"]);
    }
  });

  it("only a known set of tags is ever built", () => {
    const allowed = new Set(["p", "br", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "del", "code", "pre", "ul", "ol", "li", "a", "blockquote", "hr", "div", "table", "thead", "tbody", "tr", "th", "td"]);
    const nasty = "<svg onload=alert(1)>\n# <h1>x</h1>\n- <a href=javascript:1>y</a>\n> <style>*{}</style>\n| <td> | b |\n|---|---|\n| <tr> | x |";
    for (const e of tree(nasty).all()) expect(allowed.has(e.tagName)).toBe(true);
  });
});

describe("streaming: half-written Markdown", () => {
  it("an unclosed code fence is a code block to the end", () => {
    expect(md("Run:\n\n```sh\nzip -r out.zip", true)).toBe('<p>Run:</p><pre data-open="true"><code data-lang="sh">zip -r out.zip</code></pre>');
    // Not streaming (the final text never closed it): still a code block.
    expect(md("```\nx")).toBe("<pre><code>x</code></pre>");
  });

  it("an unclosed ** or ` renders as it will once closed; a bare trailing ** shows nothing", () => {
    expect(md("You have **4 unread", true)).toBe("<p>You have <strong>4 unread</strong></p>");
    expect(md("Run `npm i", true)).toBe("<p>Run <code>npm i</code></p>");
    expect(md("1. **Jordan Le", true)).toBe("<ol><li><strong>Jordan Le</strong></li></ol>");
    expect(md("Hello **", true)).toBe("<p>Hello </p>");
    expect(md("Hello *wor", true)).toBe("<p>Hello <em>wor</em></p>");
    // Only the last block is open: a closed earlier paragraph is unaffected.
    expect(md("a ** b\n\nnext **x", true)).toBe("<p>a ** b</p><p>next <strong>x</strong></p>");
  });

  it("a half-written link shows its text only", () => {
    expect(md("Open the [Developer Dashboard](https://chrome.goo", true)).toBe("<p>Open the Developer Dashboard</p>");
    expect(md("Open the [Develo", true)).toBe("<p>Open the Develo</p>");
    expect(closeDangling("a [b](c) d")).toBe("a [b](c) d");
  });

  it("every prefix of a long answer renders without raw ** or backticks outside code", () => {
    const answer = "## Steps\n\n1. **Zip** the `dist` folder\n   - check `manifest.json`\n2. Upload at [the dashboard](https://example.com/d)\n\n```sh\nzip -r a.zip .\n```\n\n> **Note:** review takes days.";
    for (let n = 1; n <= answer.length; n++) {
      const t = tree(answer.slice(0, n), true);
      const outsideCode = t.all().filter((e) => e.tagName !== "pre" && e.tagName !== "code");
      for (const e of outsideCode) for (const k of e.childNodes) if (!("tagName" in k)) expect((k as unknown as { data: string }).data).not.toMatch(/\*\*|`/);
    }
  });
});

describe("MarkdownView", () => {
  it("keeps the DOM of blocks that did not change and rebuilds the tail", () => {
    const root = box();
    const view = new MarkdownView(root as unknown as HTMLElement);
    view.update("First paragraph.\n\nSecond **par", true);
    const first = root.children[0];
    expect(root.innerHTML).toBe("<p>First paragraph.</p><p>Second <strong>par</strong></p>");
    view.update("First paragraph.\n\nSecond **part** done.\n\n- a", true);
    expect(root.children[0]).toBe(first);
    expect(root.innerHTML).toBe("<p>First paragraph.</p><p>Second <strong>part</strong> done.</p><ul><li>a</li></ul>");
    // The final text: same blocks, now closed.
    view.update("First paragraph.\n\nSecond **part** done.\n\n- a\n- b");
    expect(root.children[0]).toBe(first);
    expect(root.innerHTML).toBe("<p>First paragraph.</p><p>Second <strong>part</strong> done.</p><ul><li>a</li><li>b</li></ul>");
  });

  it("parseBlocks keeps each top-level block's source", () => {
    expect(parseBlocks("# T\n\ntext\nmore\n\n- a\n- b").map((b) => [b.type, b.src])).toEqual([
      ["h", "# T"],
      ["p", "text\nmore"],
      ["list", "- a\n- b"],
    ]);
  });
});
