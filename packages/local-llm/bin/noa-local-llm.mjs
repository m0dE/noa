#!/usr/bin/env node
import { main } from "../src/setup.mjs";

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`\nnoa-local-llm: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  },
);
