import { describe, expect, it } from "vitest";
import { MEMORY_SEARCH_PATH } from "@noa/shared";
import { AccountApi } from "../../src/account/account-api.js";
import { fakeApi } from "./fake-api.js";

describe("AccountApi.memorySearch", () => {
  it("posts the query to the account and returns its hits", async () => {
    const api = fakeApi();
    const reply = { model: "@cf/baai/bge-m3", hits: [{ id: "m1", score: 0.82 }], pending: 2 };
    api.on(`POST ${MEMORY_SEARCH_PATH}`, { body: reply });
    const client = new AccountApi({ apiBase: api.base, token: "bt_s_tok", fetch: api.fetch });
    const input = { query: "who is my accountant", taskKey: "t1abc", limit: 20 };
    expect(await client.memorySearch(input)).toEqual(reply);
    expect(api.calls).toEqual([expect.objectContaining({ method: "POST", path: MEMORY_SEARCH_PATH, body: input })]);
  });

  it("refuses an answer that is not a MemorySearchResponse", async () => {
    const api = fakeApi();
    api.on(`POST ${MEMORY_SEARCH_PATH}`, { body: { hits: "none" } });
    const client = new AccountApi({ apiBase: api.base, token: "bt_s_tok", fetch: api.fetch });
    await expect(client.memorySearch({ query: "x" })).rejects.toThrow();
  });
});
