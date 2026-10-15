/**
 * CPU time the test's thread has used, in ms (Node's process.threadCpuUsage). A timing check measures the work itself
 * with it: wall-clock time also counts the time the thread waited for a CPU, which on a busy machine (other test
 * workers, browsers) can be many times the work, and once is enough to fail a check on the slowest call.
 */
export function threadCpuMs(): number {
  const { process } = globalThis as unknown as { process: { threadCpuUsage(): { user: number; system: number } } };
  const used = process.threadCpuUsage();
  return (used.user + used.system) / 1000;
}
