// Source of editors.js: five real rich-text editors, one copy of each dependency, as window.NoaTestEditors.
// mount(name, element, paragraphs, label) starts editor `name` in `element` with those paragraphs, its editable
// element named `label` (aria-label), and returns { text(): its own model's text, paragraphs joined by "\n" }.
// Rebuild with build.mjs (the pinned versions are there).
import { EditorState as PmState } from "prosemirror-state";
import { EditorView as PmView } from "prosemirror-view";
import { DOMParser as PmDomParser, Schema } from "prosemirror-model";
import { schema as basicSchema } from "prosemirror-schema-basic";
import { exampleSetup } from "prosemirror-example-setup";
import { Editor as TiptapEditor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from "lexical";
import { registerRichText, HeadingNode, QuoteNode } from "@lexical/rich-text";
import Quill from "quill/core";
import quillCss from "quill/dist/quill.core.css";
import { createEditor as createSlate, Node as SlateNode } from "slate";
import { Editable, Slate, withReact } from "slate-react";
import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";

const html = (paragraphs) => paragraphs.map((p) => `<p>${p.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>`).join("");

function prosemirror(el, paragraphs, label) {
  const schema = new Schema({ nodes: basicSchema.spec.nodes, marks: basicSchema.spec.marks });
  const holder = document.createElement("div");
  holder.innerHTML = html(paragraphs);
  const view = new PmView(el, { state: PmState.create({ doc: PmDomParser.fromSchema(schema).parse(holder), plugins: exampleSetup({ schema, menuBar: false }) }), attributes: { "aria-label": label } });
  return { text: () => view.state.doc.textBetween(0, view.state.doc.content.size, "\n"), view };
}

function tiptap(el, paragraphs, label) {
  const editor = new TiptapEditor({ element: el, extensions: [StarterKit], content: html(paragraphs), editorProps: { attributes: { "aria-label": label } } });
  return { text: () => editor.getText({ blockSeparator: "\n" }), editor };
}

function lexical(el, paragraphs, label) {
  const content = document.createElement("div");
  content.contentEditable = "true";
  content.setAttribute("aria-label", label);
  el.appendChild(content);
  const editor = createEditor({ namespace: "test", nodes: [HeadingNode, QuoteNode], onError: (e) => console.error(e) });
  editor.setRootElement(content);
  registerRichText(editor);
  editor.update(() => {
    const root = $getRoot();
    for (const p of paragraphs) root.append($createParagraphNode().append($createTextNode(p)));
  }, { discrete: true });
  return { text: () => editor.getEditorState().read(() => $getRoot().getTextContent()).replace(/\n\n/g, "\n"), editor };
}

function quill(el, paragraphs, label) {
  if (!document.getElementById("quill-core-css")) {
    const style = document.createElement("style");
    style.id = "quill-core-css";
    style.textContent = quillCss;
    document.head.appendChild(style);
  }
  const q = new Quill(el, {});
  q.root.setAttribute("aria-label", label);
  q.setText(paragraphs.join("\n") + "\n");
  return { text: () => q.getText().replace(/\n$/, ""), quill: q };
}

function slate(el, paragraphs, label) {
  const editor = withReact(createSlate());
  const initialValue = paragraphs.map((p) => ({ type: "paragraph", children: [{ text: p }] }));
  function App() {
    const [value] = useState(initialValue);
    return createElement(Slate, { editor, initialValue: value }, createElement(Editable, { "aria-label": label }));
  }
  createRoot(el).render(createElement(App));
  return { text: () => editor.children.map((n) => SlateNode.string(n)).join("\n"), editor };
}

window.NoaTestEditors = {
  mount(name, el, paragraphs, label) {
    const make = { prosemirror, tiptap, lexical, quill, slate }[name];
    if (!make) throw new Error("unknown editor " + name);
    return make(el, paragraphs, label);
  },
};
