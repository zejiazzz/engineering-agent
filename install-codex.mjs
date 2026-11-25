import { runInstaller } from "./install.mjs";

runInstaller(["--host", "codex", ...process.argv.slice(2)]);
