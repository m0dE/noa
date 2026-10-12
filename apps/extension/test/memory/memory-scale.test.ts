/**
 * Memory at scale: three repeating tasks of different shapes, each with MAX_TASK_RECORDS records filed by key, beside
 * MAX_MEMORY_ENTRIES personal entries. Every key finds its own record, no personal entry is pushed out, and picking a
 * turn's memory stays fast. Prints the timings and the stored size (vitest shows the log).
 *
 * The tasks and keys are examples only (an address, a number, a multi-word code): the product knows none of them.
 */
import { describe, expect, it } from "vitest";
import { MAX_MEMORY_ENTRIES, MAX_TASK_RECORDS, memoryRecordKey, memoryTaskKey, type ExtensionSettings, type MemoryEntry, type MemoryKind } from "@noa/shared";
import { SessionStore } from "../../src/engine/sessions.js";
import { recordFor, selectMemory } from "../../src/memory/select.js";
import { MemoryService } from "../../src/memory/service.js";
import { MEMORY_STORAGE_KEY, MemoryStore } from "../../src/memory/store.js";
import { MemoryKvDb } from "../memory-kv.js";
import { memoryStorage } from "./fakes.js";

const TASKS = [
  { instructions: "Answer each new message in the shared inbox", key: (i: number) => `person${i}.name@example.com` },
  { instructions: "Check every open order on the shop dashboard and update its status", key: (i: number) => `#${100000 + i}` },
  { instructions: "Review each unit in the building list and note what needs fixing", key: (i: number) => `Block ${String.fromCharCode(65 + (i % 26))} unit ${i}` },
].map((t) => ({ ...t, taskKey: memoryTaskKey(t.instructions, null) }));

/** Records filed through the store's own write path (the rest are stored directly: a write per record would be slow to set up). */
const WRITTEN_THROUGH_STORE = 40;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();

function personalEntries(): MemoryEntry[] {
  const kinds = ["preference", "account", "person", "playbook"] as const;
  return Array.from({ length: MAX_MEMORY_ENTRIES }, (_, i) => ({
    id: `p${i}`,
    kind: kinds[i % 4]!,
    subject: `Personal fact ${i}`,
    text: `Something the user told the agent, number ${i}.`,
    scope: kinds[i % 4] === "playbook" ? "domain" : "global",
    ...(kinds[i % 4] === "playbook" ? { domain: `site${i}.example.com` } : {}),
    source: { kind: "chat" },
    // Older than every record: an eviction by age alone would take these first.
    learnedAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
  }));
}

function seededRecords(task: (typeof TASKS)[number], t: number, count: number): MemoryEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `r${t}x${i}`,
    kind: "task",
    subject: task.key(i),
    text: `What earlier runs learned about item ${i} of task ${t}.`,
    scope: "task",
    taskKey: task.taskKey,
    taskTitle: task.instructions,
    key: memoryRecordKey(task.key(i)),
    notes: [{ at: at(i), text: `Handled on run ${i % 7}.` }],
    source: { kind: "task", title: task.instructions },
    learnedAt: at(i),
    updatedAt: at(i),
  }));
}

describe("memory at scale", () => {
  it(`${TASKS.length} tasks x ${MAX_TASK_RECORDS} records and ${MAX_MEMORY_ENTRIES} personal entries: right record per key, nothing personal evicted, fast`, async () => {
    const storage = memoryStorage();
    let clock = Date.parse("2026-09-26T10:00:00Z");
    let ids = 0;
    const store = new MemoryStore({ storage, now: () => new Date((clock += 1000)), newId: () => `n${++ids}` });
    const personal = personalEntries();
    storage.data[MEMORY_STORAGE_KEY] = [...personal, ...TASKS.flatMap((task, t) => seededRecords(task, t, MAX_TASK_RECORDS - WRITTEN_THROUGH_STORE))];

    // The rest of each task's records go through the store, as remember files them.
    const writes: number[] = [];
    for (const [t, task] of TASKS.entries()) {
      for (let i = MAX_TASK_RECORDS - WRITTEN_THROUGH_STORE; i < MAX_TASK_RECORDS; i++) {
        const t0 = performance.now();
        await store.putRecord({ taskKey: task.taskKey, taskTitle: task.instructions, key: memoryRecordKey(task.key(i)), keyAsWritten: task.key(i), text: `What earlier runs learned about item ${i} of task ${t}.` }, { kind: "task" });
        writes.push(performance.now() - t0);
      }
    }
    const all = await store.list();
    expect(all).toHaveLength(MAX_MEMORY_ENTRIES + TASKS.length * MAX_TASK_RECORDS);

    // Every key of every task finds its own record (and no other task's), however the key is written.
    for (const [t, task] of TASKS.entries()) {
      for (let i = 0; i < MAX_TASK_RECORDS; i++) {
        const got = recordFor(all, task.taskKey, i % 2 ? task.key(i).toUpperCase() : ` ${task.key(i)} `);
        expect(got?.text).toBe(`What earlier runs learned about item ${i} of task ${t}.`);
      }
    }

    // A record past a task's limit pushes out that task's least recently used record, never a personal entry.
    await store.putRecord({ taskKey: TASKS[0]!.taskKey, key: "one more", keyAsWritten: "One more", text: "The newest item." }, { kind: "task" });
    const after = await store.list();
    expect(after.filter((e) => e.key === undefined).map((e) => e.id).sort()).toEqual(personal.map((e) => e.id).sort());
    expect(after.filter((e) => e.taskKey === TASKS[0]!.taskKey)).toHaveLength(MAX_TASK_RECORDS);
    expect(after.some((e) => e.id === "r0x0")).toBe(false);
    expect(after.filter((e) => e.taskKey === TASKS[1]!.taskKey)).toHaveLength(MAX_TASK_RECORDS);

    // Picking a turn's memory: the record the turn names comes first.
    const select: number[] = [];
    for (let n = 0; n < 60; n++) {
      const t = n % TASKS.length;
      const i = (n * 37) % MAX_TASK_RECORDS || 1;
      const t0 = performance.now();
      const s = selectMemory(after, { taskKey: TASKS[t]!.taskKey, hosts: [], text: TASKS[t]!.instructions, pageText: `https://app.example/items\nWorking on ${TASKS[t]!.key(i)} now` });
      select.push(performance.now() - t0);
      expect(s.entries[0]?.subject).toBe(TASKS[t]!.key(i));
    }

    // The whole turn start as a run pays it: reading the store and picking.
    const sessions = new SessionStore(new MemoryKvDb());
    const settings: Pick<ExtensionSettings, "memoryPaused" | "memoryKindsOff"> = { memoryPaused: false, memoryKindsOff: [] as MemoryKind[] };
    const service = new MemoryService({ store, sessions, settings: async () => settings });
    await sessions.create({ sessionId: "run", source: "local", title: TASKS[1]!.instructions, brain: "claude-api", jev: false, startedAt: new Date().toISOString() });
    const begin: number[] = [];
    for (let n = 0; n < 10; n++) {
      const t0 = performance.now();
      const given = await service.begin("run", { task: { instructions: TASKS[1]!.instructions, account: null }, title: "run", request: TASKS[1]!.instructions, tabTitle: `Order ${TASKS[1]!.key(500 + n)}` });
      begin.push(performance.now() - t0);
      expect(given?.entries[0]?.subject).toBe(TASKS[1]!.key(500 + n));
    }
    const recall = await service.tool("run", "recall", { key: TASKS[1]!.key(777) });
    expect(recall.text).toContain("item 777 of task 1");

    const stat = (xs: number[]) => {
      const sorted = xs.slice().sort((a, b) => a - b);
      return `median ${sorted[Math.floor(sorted.length / 2)]!.toFixed(2)} ms, max ${sorted.at(-1)!.toFixed(2)} ms`;
    };
    const bytes = new TextEncoder().encode(JSON.stringify(storage.data[MEMORY_STORAGE_KEY])).length;
    console.log(
      [
        `[memory scale] ${after.length} entries (${MAX_MEMORY_ENTRIES} personal, ${TASKS.length} x ${MAX_TASK_RECORDS} records)`,
        `  stored: ${(bytes / 1024 / 1024).toFixed(2)} MB (${Math.round(bytes / after.length)} bytes per entry)`,
        `  selectMemory: ${stat(select)}`,
        `  begin (read store + select + mark used): ${stat(begin)}`,
        `  putRecord (read, write, cap): ${stat(writes)}`,
      ].join("\n"),
    );
    expect(Math.max(...select)).toBeLessThan(100);
  }, 120_000);
});
