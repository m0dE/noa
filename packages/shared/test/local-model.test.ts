import { describe, expect, it } from "vitest";
import { localMessagesBase, localModelsUrl, localServerUrl } from "../src/local-model.js";

describe("local model server address", () => {
  it("keeps the server, dropping a trailing slash and a pasted /v1, /v1/messages or /v1/models", () => {
    for (const typed of ["http://localhost:11434", "http://localhost:11434/", " http://localhost:11434/v1 ", "http://localhost:11434/v1/messages", "http://localhost:11434/v1/models/"]) {
      expect(localServerUrl(typed)).toBe("http://localhost:11434");
    }
    // A server behind a path (a proxy) keeps it.
    expect(localServerUrl("https://gpu.lan/ollama/v1")).toBe("https://gpu.lan/ollama");
  });
  it("only http(s) addresses", () => {
    expect(localServerUrl("localhost:11434")).toBeNull();
    expect(localServerUrl("")).toBeNull();
    expect(localServerUrl("ftp://host")).toBeNull();
    expect(localMessagesBase("nope")).toBeNull();
  });
  it("the Messages base and the model list", () => {
    expect(localMessagesBase("http://127.0.0.1:1234")).toBe("http://127.0.0.1:1234/v1");
    expect(localModelsUrl("http://127.0.0.1:8080/v1")).toBe("http://127.0.0.1:8080/v1/models");
  });
});
