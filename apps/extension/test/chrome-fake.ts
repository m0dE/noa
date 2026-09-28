/**
 * Hand-written fake of the parts of the `chrome` API the extension uses.
 * `installChromeFake()` puts a fresh one on globalThis.chrome and returns it.
 */

type Listener<A extends unknown[]> = (...args: A) => unknown;

export class FakeEvent<A extends unknown[]> {
  readonly listeners: Listener<A>[] = [];
  addListener(fn: Listener<A>): void {
    this.listeners.push(fn);
  }
  removeListener(fn: Listener<A>): void {
    const i = this.listeners.indexOf(fn);
    if (i >= 0) this.listeners.splice(i, 1);
  }
  hasListener(fn: Listener<A>): boolean {
    return this.listeners.includes(fn);
  }
  emit(...args: A): unknown[] {
    return this.listeners.map((fn) => fn(...args));
  }
}

type Changes = Record<string, { oldValue?: unknown; newValue?: unknown }>;

export class FakeStorageArea {
  data: Record<string, unknown> = {};
  constructor(
    private readonly areaName: string,
    private readonly onChanged: FakeEvent<[Changes, string]>,
  ) {}
  async get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
    if (keys == null) return clone(this.data);
    const list = Array.isArray(keys) ? keys : [keys];
    const out: Record<string, unknown> = {};
    for (const k of list) if (k in this.data) out[k] = clone(this.data[k]);
    return out;
  }
  async set(items: Record<string, unknown>): Promise<void> {
    const changes: Changes = {};
    for (const [k, v] of Object.entries(items)) {
      changes[k] = { oldValue: this.data[k], newValue: clone(v) };
      this.data[k] = clone(v);
    }
    this.onChanged.emit(changes, this.areaName);
  }
  async remove(keys: string | string[]): Promise<void> {
    const changes: Changes = {};
    for (const k of Array.isArray(keys) ? keys : [keys]) {
      if (k in this.data) changes[k] = { oldValue: this.data[k] };
      delete this.data[k];
    }
    this.onChanged.emit(changes, this.areaName);
  }
}

export interface FakeAlarm {
  name: string;
  periodInMinutes?: number;
  scheduledTime: number;
}

export interface FakePort {
  name: string;
  posted: unknown[];
  postMessage(msg: unknown): void;
  disconnect(): void;
  onMessage: FakeEvent<[unknown]>;
  onDisconnect: FakeEvent<[FakePort]>;
  /** Test helper: simulate the host sending a message. */
  deliver(msg: unknown): void;
  /** Test helper: simulate the host closing the port. */
  hostDisconnect(error?: string): void;
}

/**
 * A runtime.Port whose other end the test plays: deliver() is a message from
 * there, hostDisconnect() closes it from there (with chrome.runtime.lastError
 * set through setLastError while its listeners run).
 */
export function fakePort(name: string, setLastError: (message?: string) => void = () => {}): FakePort {
  const port: FakePort = {
    name,
    posted: [],
    onMessage: new FakeEvent(),
    onDisconnect: new FakeEvent(),
    postMessage(msg) {
      port.posted.push(msg);
    },
    disconnect() {
      /* a client-side disconnect does not fire onDisconnect in Chrome */
    },
    deliver(msg) {
      port.onMessage.emit(msg);
    },
    hostDisconnect(error) {
      setLastError(error);
      port.onDisconnect.emit(port);
      setLastError(undefined);
    },
  };
  return port;
}

/** A chrome.storage area on its own (no chrome fake around it), for code that takes a StorageLike. */
export function memoryStorageArea(name = "local"): FakeStorageArea {
  return new FakeStorageArea(name, new FakeEvent());
}

export interface FakeTab {
  id: number;
  windowId: number;
  url: string;
  active: boolean;
  groupId: number;
  status?: string;
  title?: string;
}

export interface FakeWindow {
  id: number;
  type: string;
  state: string;
  tabs: FakeTab[];
}

export interface FakeTabGroup {
  id: number;
  windowId: number;
  title: string;
  color: string;
}

export interface FakeDownload {
  id: number;
  url: string;
  filename: string;
  headers?: { name: string; value: string }[];
  state: "in_progress" | "complete" | "interrupted";
  error?: string;
  removed: boolean;
  erased: boolean;
}

/** Chrome's error for chrome.debugger on a tab with another extension's frame. */
export const FOREIGN_FRAME_ERROR = "Cannot access a chrome-extension:// URL of different extension";

export function installChromeFake() {
  const onChanged = new FakeEvent<[Changes, string]>();
  let nextTabId = 100;
  let nextWindowId = 10;
  let nextGroupId = 500;

  const tabView = (t: FakeTab) => {
    const w = fake.windows.byId.get(t.windowId);
    return { ...t, status: t.status ?? "complete", index: w ? w.tabs.indexOf(t) : 0 };
  };
  const activate = (t: FakeTab) => {
    const was = t.active;
    for (const other of fake.windows.byId.get(t.windowId)?.tabs ?? []) other.active = other === t;
    if (!was) fake.tabs.onActivated.emit({ tabId: t.id, windowId: t.windowId });
  };

  const fake = {
    runtime: {
      id: "testextensionid",
      lastError: undefined as { message: string } | undefined,
      getURL: (p: string) => `chrome-extension://testextensionid/${p.replace(/^\//, "")}`,
      ports: [] as FakePort[],
      onMessage: new FakeEvent<unknown[]>(),
      onConnect: new FakeEvent<unknown[]>(),
      platformInfoCalls: 0,
      async getPlatformInfo() {
        fake.runtime.platformInfoCalls++;
        return { os: "win", arch: "x86-64", nacl_arch: "x86-64" };
      },
      onInstalled: new FakeEvent<unknown[]>(),
      onStartup: new FakeEvent<unknown[]>(),
      /** Called for every new native port; tests use it to script the host. */
      onConnectNative: undefined as ((port: FakePort) => void) | undefined,
      connectNative(name: string): FakePort {
        const port = fakePort(name, (message) => (fake.runtime.lastError = message ? { message } : undefined));
        fake.runtime.ports.push(port);
        fake.runtime.onConnectNative?.(port);
        return port;
      },
    },
    storage: {
      onChanged,
      local: new FakeStorageArea("local", onChanged),
      session: new FakeStorageArea("session", onChanged),
    },
    alarms: {
      all: new Map<string, FakeAlarm>(),
      async create(name: string, info: { periodInMinutes?: number; delayInMinutes?: number; when?: number }) {
        fake.alarms.all.set(name, {
          name,
          periodInMinutes: info.periodInMinutes,
          scheduledTime: info.when ?? Date.now() + (info.delayInMinutes ?? info.periodInMinutes ?? 0) * 60_000,
        });
      },
      async get(name: string) {
        return fake.alarms.all.get(name);
      },
      async clear(name: string) {
        return fake.alarms.all.delete(name);
      },
      onAlarm: new FakeEvent<[FakeAlarm]>(),
    },
    notifications: {
      created: [] as { id?: string; options: Record<string, unknown> }[],
      async create(idOrOptions: unknown, options?: unknown) {
        if (typeof idOrOptions === "string") {
          fake.notifications.created.push({ id: idOrOptions, options: options as Record<string, unknown> });
          return idOrOptions;
        }
        fake.notifications.created.push({ options: idOrOptions as Record<string, unknown> });
        return `n${fake.notifications.created.length}`;
      },
    },
    tabs: {
      byId: new Map<number, FakeTab>(),
      createCalls: [] as Record<string, unknown>[],
      updateCalls: [] as { id: number; props: Record<string, unknown> }[],
      async get(id: number) {
        const t = fake.tabs.byId.get(id);
        if (!t) throw new Error(`No tab with id: ${id}.`);
        return tabView(t);
      },
      async query(q: { active?: boolean; lastFocusedWindow?: boolean; windowId?: number; windowType?: string }) {
        const out = [];
        for (const w of fake.windows.byId.values()) {
          if (q.windowId !== undefined && w.id !== q.windowId) continue;
          if (q.lastFocusedWindow && w.id !== fake.windows.focusOrder.at(-1)) continue;
          if (q.windowType && w.type !== q.windowType) continue;
          for (const t of w.tabs) if (q.active === undefined || t.active === q.active) out.push(tabView(t));
        }
        return out;
      },
      async create(opts: { windowId?: number; index?: number; active?: boolean; url?: string }) {
        fake.tabs.createCalls.push({ ...opts });
        const windowId = opts.windowId ?? fake.windows.focusOrder.at(-1);
        const w = windowId === undefined ? undefined : fake.windows.byId.get(windowId);
        if (!w) throw new Error(`No window with id: ${windowId}.`);
        const tab: FakeTab = { id: nextTabId++, windowId: w.id, url: opts.url ?? "chrome://newtab/", active: false, groupId: -1 };
        w.tabs.splice(opts.index ?? w.tabs.length, 0, tab);
        fake.tabs.byId.set(tab.id, tab);
        if (opts.active !== false) activate(tab);
        return tabView(tab);
      },
      async update(id: number, props: { active?: boolean; url?: string }) {
        fake.tabs.updateCalls.push({ id, props: { ...props } });
        const t = fake.tabs.byId.get(id);
        if (!t) throw new Error(`No tab with id: ${id}.`);
        if (props.active) activate(t);
        if (props.url !== undefined) {
          t.url = props.url;
          t.status = "complete";
        }
        return tabView(t);
      },
      async remove(id: number) {
        const t = fake.tabs.byId.get(id);
        if (!t) throw new Error(`No tab with id: ${id}.`);
        const w = fake.windows.byId.get(t.windowId)!;
        w.tabs.splice(w.tabs.indexOf(t), 1);
        fake.tabs.byId.delete(id);
        fake.tabs.onRemoved.emit(id, { windowId: t.windowId, isWindowClosing: false });
      },
      async group(opts: { tabIds: number[]; groupId?: number; createProperties?: { windowId?: number } }) {
        let groupId = opts.groupId;
        if (groupId === undefined) {
          groupId = nextGroupId++;
          const windowId = opts.createProperties?.windowId ?? fake.tabs.byId.get(opts.tabIds[0]!)!.windowId;
          fake.tabGroups.byId.set(groupId, { id: groupId, windowId, title: "", color: "grey" });
        }
        if (!fake.tabGroups.byId.has(groupId)) throw new Error(`No group with id: ${groupId}.`);
        for (const id of opts.tabIds) fake.tabs.byId.get(id)!.groupId = groupId;
        return groupId;
      },
      captureCalls: [] as { windowId: number; opts: Record<string, unknown> }[],
      async captureVisibleTab(windowId: number, opts: Record<string, unknown>) {
        fake.tabs.captureCalls.push({ windowId, opts });
        return "data:image/jpeg;base64,RkFLRQ==";
      },
      onUpdated: new FakeEvent<unknown[]>(),
      onRemoved: new FakeEvent<unknown[]>(),
      onActivated: new FakeEvent<unknown[]>(),
    },
    scripting: {
      calls: [] as { tabId: number; frameIds?: number[]; func: (...a: any[]) => unknown; args: unknown[] }[],
      /** Documents the default load reading has handed out (each reading is a new one). */
      documents: 0,
      /** Test hook deciding each injection's result (the page function's return value). */
      respond: ((_func: (...a: any[]) => unknown, _args: unknown[]): unknown => ({ ok: true, value: true })) as (
        func: (...a: any[]) => unknown,
        args: unknown[],
      ) => unknown,
      async executeScript(inj: { target: { tabId: number; frameIds?: number[] }; func: (...a: any[]) => unknown; args?: unknown[] }) {
        if (!fake.tabs.byId.has(inj.target.tabId)) throw new Error(`No tab with id: ${inj.target.tabId}.`);
        const args = inj.args ?? [];
        fake.scripting.calls.push({ tabId: inj.target.tabId, frameIds: inj.target.frameIds, func: inj.func, args });
        const result = fake.scripting.respond(inj.func, args);
        // A page's load reading (page-load.ts) the test did not answer itself: a complete page, a new document each time.
        if (inj.func.name === "loadProbeInPage" && !(result && typeof result === "object" && "doc" in result)) {
          return [{ frameId: 0, documentId: "doc", result: { doc: ++fake.scripting.documents, state: "complete", controls: 1, text: 1, foreignFrame: false } }];
        }
        return [{ frameId: 0, documentId: "doc", result }];
      },
    },
    tabGroups: {
      byId: new Map<number, FakeTabGroup>(),
      async get(id: number) {
        const g = fake.tabGroups.byId.get(id);
        if (!g) throw new Error(`No group with id: ${id}.`);
        return { ...g };
      },
      async query(q: { windowId?: number; title?: string }) {
        return [...fake.tabGroups.byId.values()]
          .filter((g) => (q.windowId === undefined || g.windowId === q.windowId) && (q.title === undefined || g.title === q.title))
          .map((g) => ({ ...g }));
      },
      async update(id: number, props: { title?: string; color?: string }) {
        const g = fake.tabGroups.byId.get(id);
        if (!g) throw new Error(`No group with id: ${id}.`);
        Object.assign(g, props);
        return { ...g };
      },
    },
    windows: {
      byId: new Map<number, FakeWindow>(),
      /** Window ids in focus order; the last one is the last focused. */
      focusOrder: [] as number[],
      createCalls: [] as Record<string, unknown>[],
      updateCalls: [] as { id: number; props: Record<string, unknown> }[],
      async create(opts: Record<string, unknown>) {
        fake.windows.createCalls.push(opts);
        const id = nextWindowId++;
        const tab: FakeTab = { id: nextTabId++, windowId: id, url: String(opts.url ?? "chrome://newtab/"), active: true, groupId: -1 };
        fake.tabs.byId.set(tab.id, tab);
        fake.windows.byId.set(id, { id, type: String(opts.type ?? "normal"), state: "normal", tabs: [tab] });
        if (opts.focused !== false) fake.windows.focusOrder.push(id);
        else fake.windows.focusOrder.unshift(id);
        return { id, tabs: [tabView(tab)] };
      },
      async get(id: number, _opts?: unknown) {
        const w = fake.windows.byId.get(id);
        if (!w) throw new Error(`No window with id: ${id}.`);
        return { id: w.id, type: w.type, state: w.state, tabs: w.tabs.map(tabView) };
      },
      async getLastFocused(opts?: { windowTypes?: string[] }) {
        const id = [...fake.windows.focusOrder].reverse().find((wid) => {
          const w = fake.windows.byId.get(wid);
          return w && (!opts?.windowTypes || opts.windowTypes.includes(w.type));
        });
        if (id === undefined) throw new Error("No last-focused window");
        return fake.windows.get(id);
      },
      async update(id: number, props: { focused?: boolean; state?: string }) {
        fake.windows.updateCalls.push({ id, props: { ...props } });
        const w = fake.windows.byId.get(id);
        if (!w) throw new Error(`No window with id: ${id}.`);
        if (props.state) w.state = props.state;
        if (props.focused) {
          fake.windows.focusOrder = fake.windows.focusOrder.filter((x) => x !== id);
          fake.windows.focusOrder.push(id);
        }
        return fake.windows.get(id);
      },
      async remove(id: number) {
        const w = fake.windows.byId.get(id);
        if (!w) throw new Error(`No window with id: ${id}.`);
        for (const t of w.tabs) fake.tabs.byId.delete(t.id);
        fake.windows.byId.delete(id);
        fake.windows.focusOrder = fake.windows.focusOrder.filter((x) => x !== id);
      },
      onRemoved: new FakeEvent<unknown[]>(),
    },
    debugger: {
      attached: new Set<number>(),
      /** Tabs showing another extension's frame: Chrome refuses the debugger there. */
      blocked: new Set<number>(),
      /** Tabs Chrome keeps extensions out of (Web Store, chrome://): tab id -> Chrome's error. */
      refused: new Map<number, string>(),
      commands: [] as { tabId: number; method: string; params?: unknown }[],
      /** Test hook deciding each command's result. */
      respond: ((_method: string, _params: unknown): unknown => ({})) as (method: string, params: any) => unknown,
      /** How many attaches were tried. */
      attachCalls: 0,
      async attach(target: { tabId: number }, _version: string) {
        fake.debugger.attachCalls++;
        if (fake.debugger.blocked.has(target.tabId)) throw new Error(FOREIGN_FRAME_ERROR);
        const refused = fake.debugger.refused.get(target.tabId);
        if (refused) throw new Error(refused);
        if (fake.debugger.attached.has(target.tabId)) {
          throw new Error(`Another debugger is already attached to the tab with id: ${target.tabId}.`);
        }
        fake.debugger.attached.add(target.tabId);
      },
      async detach(target: { tabId: number }) {
        fake.debugger.attached.delete(target.tabId);
      },
      async sendCommand(target: { tabId: number }, method: string, params?: unknown) {
        if (fake.debugger.blocked.has(target.tabId)) throw new Error(FOREIGN_FRAME_ERROR);
        if (!fake.debugger.attached.has(target.tabId)) {
          throw new Error(`Debugger is not attached to the tab with id: ${target.tabId}.`);
        }
        fake.debugger.commands.push({ tabId: target.tabId, method, params });
        return fake.debugger.respond(method, params);
      },
      onDetach: new FakeEvent<[{ tabId?: number }, string]>(),
      onEvent: new FakeEvent<unknown[]>(),
    },
    action: { onClicked: new FakeEvent<unknown[]>() },
    sidePanel: {
      behavior: null as unknown,
      async setPanelBehavior(b: unknown) {
        fake.sidePanel.behavior = b;
      },
    },
    downloads: {
      items: [] as FakeDownload[],
      uiEnabled: true,
      /** Every setUiOptions call, in order. */
      uiCalls: [] as boolean[],
      /** Download directory used for absolute paths. */
      dir: "C:\\Users\\me\\Downloads",
      /** Test hook: how a new download ends. Default: completes on the next tick. */
      behavior: ((_d: FakeDownload): "complete" | "interrupted" | "hang" => "complete") as (d: FakeDownload) => "complete" | "interrupted" | "hang",
      onChanged: new FakeEvent<[{ id: number; state?: { current?: string }; error?: { current?: string } }]>(),
      async download(opts: { url: string; filename?: string; headers?: { name: string; value: string }[] }) {
        const id = fake.downloads.items.length + 1;
        const rel = (opts.filename ?? "download").replace(/\//g, "\\");
        const d: FakeDownload = { id, url: opts.url, filename: "", headers: opts.headers, state: "in_progress", removed: false, erased: false };
        fake.downloads.items.push(d);
        const how = fake.downloads.behavior(d);
        if (how !== "hang") {
          setTimeout(() => {
            if (how === "complete") {
              d.state = "complete";
              d.filename = `${fake.downloads.dir}\\${rel}`;
            } else {
              d.state = "interrupted";
              d.error = "SERVER_FORBIDDEN";
            }
            fake.downloads.onChanged.emit({ id, state: { current: d.state } });
          }, 0);
        }
        return id;
      },
      async search(q: { id: number }) {
        const d = fake.downloads.items.find((x) => x.id === q.id && !x.erased);
        return d ? [{ id: d.id, state: d.state, filename: d.filename, error: d.error }] : [];
      },
      async setUiOptions(o: { enabled: boolean }) {
        fake.downloads.uiEnabled = o.enabled;
        fake.downloads.uiCalls.push(o.enabled);
      },
      async removeFile(id: number) {
        const d = fake.downloads.items.find((x) => x.id === id);
        if (d) d.removed = true;
      },
      async erase(q: { id: number }) {
        const d = fake.downloads.items.find((x) => x.id === q.id);
        if (d) d.erased = true;
        return d ? [d.id] : [];
      },
    },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = fake;
  return fake;
}

export type ChromeFake = ReturnType<typeof installChromeFake>;

function clone<T>(v: T): T {
  return v === undefined ? v : structuredClone(v);
}
