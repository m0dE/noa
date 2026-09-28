/** Newline-delimited JSON, used on the named pipe between the MCP server and the helper (and on Claude Code's stream-json stdout). */
import { StringDecoder } from "node:string_decoder";

export function encodeLine(msg: unknown): string {
  // JSON.stringify escapes newlines inside strings, so one message is one line.
  return JSON.stringify(msg) + "\n";
}

/** Splits a UTF-8 stream into complete, trimmed, non-empty lines. */
export class LineSplitter {
  private readonly text = new StringDecoder("utf8");
  private rest = "";

  push(chunk: Buffer | string): string[] {
    this.rest += typeof chunk === "string" ? chunk : this.text.write(chunk);
    const out: string[] = [];
    let nl: number;
    while ((nl = this.rest.indexOf("\n")) >= 0) {
      const line = this.rest.slice(0, nl).trim();
      this.rest = this.rest.slice(nl + 1);
      if (line) out.push(line);
    }
    return out;
  }
}

export class LineDecoder {
  private readonly lines = new LineSplitter();

  push(chunk: Buffer | string): unknown[] {
    return this.lines.push(chunk).map((line) => JSON.parse(line) as unknown);
  }
}
