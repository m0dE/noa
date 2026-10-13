// Steps, waits and the pass/fail summary shared by the Playwright e2e scripts.

/**
 * A named list of steps. step(title, fn) runs fn, prints "ok"/"FAIL" with what fn returned
 * (or the error) and goes on with the next step; finish() prints "<passed>/<total> <name> steps
 * passed" and exits the process with 0 when every step passed, else 1.
 */
export function createSuite(name) {
  const results = [];
  const step = async (title, fn) => {
    try {
      const detail = await fn();
      results.push({ title, ok: true, detail });
      console.log(`ok   ${title}${detail ? ` - ${detail}` : ""}`);
    } catch (err) {
      results.push({ title, ok: false, detail: err.message });
      console.log(`FAIL ${title} - ${err.stack ?? err.message}`);
    }
  };
  const finish = () => {
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} ${name} steps passed`);
    process.exit(failed ? 1 : 0);
  };
  return { step, finish };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const describe = (v) => (v instanceof Error ? v.message : JSON.stringify(v));

/**
 * Polls fn every `every` ms until it returns something truthy, and returns that. After `timeout`
 * ms it throws "timed out waiting for <what>" with the last value fn returned or the last error
 * it threw, so a timeout says what it saw.
 */
export async function waitFor(fn, what, { timeout = 10_000, every = 100 } = {}) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what} (last: ${describe(last)})`);
    await sleep(every);
  }
}
