import { describe, expect, it } from "vitest";
import { BRIDGE_ALLOWED_DOMAINS, parseBridgeRequest } from "../src/noa-browser.js";

describe("parseBridgeRequest", () => {
  it("accepts the four requests", () => {
    expect(parseBridgeRequest('{"id":1,"op":"hello","token":"t"}')).toEqual({ id: 1, op: "hello", token: "t" });
    expect(parseBridgeRequest('{"id":2,"op":"attach","tabId":3,"targetId":"T"}')).toMatchObject({ op: "attach" });
    expect(parseBridgeRequest('{"id":3,"op":"detach","tabId":3}')).toMatchObject({ op: "detach" });
    expect(parseBridgeRequest('{"id":4,"op":"send","tabId":3,"method":"Page.navigate","params":{"url":"x"}}')).toMatchObject({ op: "send" });
  });
  it.each([
    "not json",
    "null",
    '{"op":"hello","token":"t"}',
    '{"id":1,"op":"shell"}',
    '{"id":1,"op":"attach","tabId":"3","targetId":"T"}',
    '{"id":1,"op":"attach","tabId":3,"targetId":""}',
    '{"id":1,"op":"send","tabId":3,"method":"eval"}',
    '{"id":1,"op":"send","tabId":3,"method":"Page.navigate","params":[1]}',
  ])("refuses %s", (text) => {
    expect(parseBridgeRequest(text)).toBeNull();
  });
  it("tab domains only", () => {
    expect(BRIDGE_ALLOWED_DOMAINS.has("Input")).toBe(true);
    for (const d of ["Browser", "Target", "Storage", "SystemInfo", "Tethering"]) expect(BRIDGE_ALLOWED_DOMAINS.has(d)).toBe(false);
  });
});
