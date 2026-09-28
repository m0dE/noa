// Bundled beside a helper build by bundle-paths.test.ts: prints the paths the bundled config resolves from there.
import { helperRoot, loadConfig } from "../../src/config.js";

const cfg = loadConfig(process.env, { dotenvDirs: [] });
process.stdout.write(JSON.stringify({ mcpServerPath: cfg.mcpServerPath, helperRoot: helperRoot() }));
