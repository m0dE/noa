import type { BookmarkNode, BookmarkSyncInput, BookmarkSyncResponse } from "@noa/shared";
import { FakeEvent } from "../chrome-fake.js";
import type { BookmarksApi, LocalNode } from "../../src/bookmarks/sync.js";

interface Stored {
  id: string;
  title: string;
  url?: string;
  children?: Stored[];
  folderType?: string;
  unmodifiable?: string;
}

/** chrome.bookmarks in memory: the root "0" with the bar ("1"), Other ("2") and Mobile ("3"). */
export class FakeBookmarks implements BookmarksApi {
  private next = 100;
  readonly root: Stored = {
    id: "0",
    title: "",
    children: [
      { id: "1", title: "Bookmarks bar", folderType: "bookmarks-bar", children: [] },
      { id: "2", title: "Other bookmarks", folderType: "other", children: [] },
      { id: "3", title: "Mobile bookmarks", folderType: "mobile", children: [] },
    ],
  };
  onCreated = new FakeEvent<unknown[]>();
  onRemoved = new FakeEvent<unknown[]>();
  onChanged = new FakeEvent<unknown[]>();
  onMoved = new FakeEvent<unknown[]>();
  onChildrenReordered = new FakeEvent<unknown[]>();
  onImportEnded = new FakeEvent<unknown[]>();

  private find(id: string, node: Stored = this.root, parent: Stored | null = null): { node: Stored; parent: Stored | null } | null {
    if (node.id === id) return { node, parent };
    for (const c of node.children ?? []) {
      const f = this.find(id, c, node);
      if (f) return f;
    }
    return null;
  }

  private view(node: Stored, parentId?: string, index?: number): LocalNode {
    return {
      id: node.id,
      title: node.title,
      ...(parentId !== undefined ? { parentId, index } : {}),
      ...(node.url ? { url: node.url } : {}),
      ...(node.folderType ? { folderType: node.folderType } : {}),
      ...(node.unmodifiable ? { unmodifiable: node.unmodifiable } : {}),
      ...(node.children ? { children: node.children.map((c, i) => this.view(c, node.id, i)) } : {}),
    };
  }

  async getTree(): Promise<LocalNode[]> {
    return [this.view(this.root)];
  }

  async create(b: { parentId: string; index?: number; title?: string; url?: string }): Promise<LocalNode> {
    const parent = this.find(b.parentId)?.node;
    if (!parent?.children) throw new Error("Can't find parent bookmark for id.");
    const node: Stored = { id: String(this.next++), title: b.title ?? "", ...(b.url ? { url: b.url } : { children: [] }) };
    parent.children.splice(b.index ?? parent.children.length, 0, node);
    this.onCreated.emit(node.id, this.view(node));
    return this.view(node, parent.id, parent.children.indexOf(node));
  }

  async update(id: string, changes: { title?: string; url?: string }): Promise<LocalNode> {
    const f = this.find(id);
    if (!f) throw new Error("Can't find bookmark for id.");
    if (changes.title !== undefined) f.node.title = changes.title;
    if (changes.url !== undefined) f.node.url = changes.url;
    this.onChanged.emit(id, changes);
    return this.view(f.node);
  }

  async move(id: string, to: { parentId: string; index?: number }): Promise<LocalNode> {
    const f = this.find(id);
    const target = this.find(to.parentId)?.node;
    if (!f?.parent || !target?.children) throw new Error("Can't find bookmark for id.");
    if (this.find(to.parentId, f.node)) throw new Error("Can't move a folder into itself");
    f.parent.children!.splice(f.parent.children!.indexOf(f.node), 1);
    target.children.splice(Math.min(to.index ?? target.children.length, target.children.length), 0, f.node);
    this.onMoved.emit(id, {});
    return this.view(f.node);
  }

  async removeTree(id: string): Promise<void> {
    const f = this.find(id);
    if (!f?.parent) throw new Error("Can't find bookmark for id.");
    f.parent.children!.splice(f.parent.children!.indexOf(f.node), 1);
    this.onRemoved.emit(id, {});
  }

  /** The tree as "title <url>" lines, indented by depth, under the three roots. */
  outline(): string[] {
    const lines: string[] = [];
    const walk = (n: Stored, depth: number) => {
      lines.push(`${"  ".repeat(depth)}${n.title}${n.url ? ` <${n.url}>` : ""}`);
      n.children?.forEach((c) => walk(c, depth + 1));
    };
    this.root.children!.forEach((c) => walk(c, 0));
    return lines;
  }

  /** The local id of the node with this title. */
  idOf(title: string): string {
    const walk = (n: Stored): string | null => (n.title === title ? n.id : (n.children ?? []).reduce<string | null>((a, c) => a ?? walk(c), null));
    const id = walk(this.root);
    if (!id) throw new Error(`no bookmark "${title}"`);
    return id;
  }
}

/** The account server's bookmark sync in memory (the same rules as apps/api/src/routes/bookmarks.ts). */
export class FakeBookmarkServer {
  rev = 0;
  readonly rows = new Map<string, BookmarkNode & { rev: number }>();
  requests: BookmarkSyncInput[] = [];

  changes(since: number): BookmarkSyncResponse {
    return {
      rev: this.rev,
      nodes: [...this.rows.values()]
        .filter((r) => r.rev > since)
        .sort((a, b) => a.rev - b.rev || a.guid.localeCompare(b.guid))
        .map(({ rev: _r, ...n }) => n),
    };
  }

  sync(input: BookmarkSyncInput): BookmarkSyncResponse {
    this.requests.push(structuredClone(input));
    if (input.changes.length) {
      const rev = ++this.rev;
      for (const n of input.changes) {
        const had = this.rows.get(n.guid);
        if (had && had.updatedAt > n.updatedAt) continue;
        this.rows.set(n.guid, { ...n, ...(n.deleted ? { title: "", url: null } : {}), rev });
      }
    }
    return this.changes(input.since);
  }

  api() {
    return { bookmarkSync: async (i: BookmarkSyncInput) => this.sync(i), bookmarkChanges: async (since: number) => this.changes(since) };
  }
}
