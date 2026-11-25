import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const installerUrl = new URL("../install.mjs", import.meta.url);
const installer = fileURLToPath(installerUrl);
const skill = "skills/engineering-agent/SKILL.md";
const hostFiles = {
  codex: ["AGENTS.md", "agents/code-reviewer.toml"],
  "claude-code": ["CLAUDE.md", "agents/code-reviewer.md"],
  cursor: [skill, "agents/code-reviewer.md"],
  workbuddy: [skill],
  "deepseek-harness": ["AGENTS.md", skill],
  opencode: ["AGENTS.md", "agents/code-reviewer.md"],
};

function setup(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "engineering-agent-test-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const bundle = join(root, "shared", ".agent-harness");
  const project = join(root, "project");
  mkdirSync(project);
  function run(args) {
    const result = spawnSync(process.execPath, args, {
      cwd: project,
      env: { ...process.env, AGENT_HARNESS_HOME: bundle },
      encoding: "utf8",
    });
    assert.ifError(result.error);
    return result;
  }
  return {
    root,
    bundle,
    project,
    run,
    install: (host, ...flags) =>
      run([installer, "--host", host, "--host-dir", join(root, host), ...flags]),
    compose: (...ids) => run([join(bundle, "compose.mjs"), ...ids]),
  };
}

function passed(result) {
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function put(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function read(path) {
  return readFileSync(path, "utf8");
}

test("all hosts preview and install into separate user directories with one shared bundle", (t) => {
  const fixture = setup(t);
  const { root, bundle } = fixture;
  const original = "# Existing user rules\n\nKeep these instructions.\n";

  for (const [host, files] of Object.entries(hostFiles)) {
    const hostDir = join(root, host);
    const outputs = files.map((file) => join(hostDir, file));
    const preview = JSON.parse(passed(fixture.install(host, "--dry-run")));
    assert.equal(preview.host, host);
    assert.equal(preview.packageDir, bundle);
    assert.deepEqual(preview.files.map(({ path }) => path), outputs);
    assert.equal(preview.nativeReviewer, files.some((file) => file.startsWith("agents/")));
    assert.equal(existsSync(hostDir), false);
    if (host === "codex") assert.equal(existsSync(dirname(bundle)), false);

    const instruction = files.find((file) => ["AGENTS.md", "CLAUDE.md"].includes(file));
    if (instruction) put(join(hostDir, instruction), original);

    passed(fixture.install(host));
    const written = outputs.map(read);
    for (const config of written) assert.ok(config.includes(bundle));
    if (instruction) {
      assert.ok(written[0].startsWith(original));
      assert.equal(written[0].split("<!-- business-agent:start -->").length, 2);
    }
    passed(fixture.install(host));
    assert.deepEqual(outputs.map(read), written);

    for (const doc of ["README.md", "INSTALL.md", "CONTRIBUTING.md", "LICENSE"]) {
      assert.equal(read(join(bundle, doc)), read(new URL("../" + doc, import.meta.url)));
    }
  }
});

test("Codex generated instructions and Claude Code symlinks can use bundle-only", (t) => {
  const { root, bundle, install } = setup(t);
  const codex = join(root, "codex", "AGENTS.md");
  const generated = "<!-- ai-rules:generated -->\n# Existing rules\n";
  put(codex, generated);

  const codexConflict = install("codex");
  assert.equal(codexConflict.status, 1);
  assert.match(codexConflict.stderr, /--bundle-only/);
  assert.equal(existsSync(bundle), false);
  passed(install("codex", "--bundle-only"));
  assert.equal(read(codex), generated);
  assert.ok(existsSync(join(root, "codex", "agents/code-reviewer.toml")));

  const claude = join(root, "claude-code", "CLAUDE.md");
  const ruleSource = join(root, "rules.md");
  put(ruleSource, "# Existing Claude Code rules\n");
  mkdirSync(dirname(claude));
  symlinkSync(ruleSource, claude, "file");

  const claudeConflict = install("claude-code");
  assert.equal(claudeConflict.status, 1);
  assert.match(claudeConflict.stderr, /--bundle-only/);
  passed(install("claude-code", "--bundle-only"));
  assert.equal(realpathSync(claude), ruleSource);
  assert.equal(read(ruleSource), "# Existing Claude Code rules\n");
  assert.ok(existsSync(join(root, "claude-code", skill)));
  assert.ok(existsSync(join(root, "claude-code", "agents/code-reviewer.md")));
});

test("install preserves a user-owned native role", (t) => {
  const { root, bundle, install } = setup(t);
  const reviewer = join(root, "cursor", "agents/code-reviewer.md");
  put(reviewer, "# User-owned reviewer\n");

  const result = install("cursor");
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(reviewer));
  assert.equal(read(reviewer), "# User-owned reviewer\n");
  assert.equal(existsSync(bundle), false);
  assert.equal(existsSync(join(root, "cursor", skill)), false);
});

test("failed host write restores the previous shared bundle and instructions", (t) => {
  const { root, bundle, run, install } = setup(t);
  passed(install("codex"));
  const core = join(bundle, "core.md");
  const priorCore = "# Previously installed core\n";
  put(core, priorCore);
  const hostDir = join(root, "claude-code");
  const instructions = join(hostDir, "CLAUDE.md");
  const original = "# Existing rules\n";
  put(instructions, original);
  const reviewer = join(hostDir, "agents/code-reviewer.md");
  const injectFailure = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (to === ${JSON.stringify(reviewer)}) throw new Error("injected host write failure");
      return rename(from, to);
    };
    syncBuiltinESMExports();
    const { runInstaller } = await import(${JSON.stringify(installerUrl.href)});
    runInstaller(["--host", "claude-code", "--host-dir", ${JSON.stringify(hostDir)}]);
  `;
  const result = run(["--input-type=module", "--eval", injectFailure]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /injected host write failure/);
  assert.equal(read(core), priorCore);
  assert.equal(read(instructions), original);
  assert.equal(existsSync(reviewer), false);
  assert.deepEqual(readdirSync(dirname(bundle)), [".agent-harness"]);
});

test("installed CLI composes defaults and honors project settings", (t) => {
  const { bundle, project, install, compose } = setup(t);
  passed(install("codex"));
  const { plugins } = JSON.parse(read(join(bundle, "defaults.json")));
  const core = join(bundle, "core.md");
  const defaultIds = plugins.map(({ id }) => id);
  assert.deepEqual(defaultIds, [
    "feishu-defects",
    "talk-live-verification",
    "git-delivery",
    "code-review",
    "frontend-standards",
    "engineering-diagnostics",
  ]);
  assert.deepEqual(JSON.parse(passed(compose(...defaultIds))), [
    core,
    ...plugins.map(({ entry }) => join(bundle, entry)),
  ]);

  const profile = join(project, "docs/project.md");
  const adapter = join(project, "docs/review.md");
  const projectPlugin = join(project, "docs/migration.md");
  for (const path of [profile, adapter, projectPlugin]) put(path, "# Project\n");
  put(join(project, ".agent-harness.json"), JSON.stringify({
    schemaVersion: 1,
    profile: "docs/project.md",
    plugins: [
      { id: "code-review", adapter: "docs/review.md" },
      { id: "talk-live-verification", enabled: false },
      { id: "migration", when: "Handle a migration", entry: "docs/migration.md" },
    ],
  }));

  assert.deepEqual(JSON.parse(passed(compose())), [core, profile]);
  assert.deepEqual(JSON.parse(passed(compose("migration", "code-review"))), [
    core,
    profile,
    join(bundle, "plugins/code-review.md"),
    adapter,
    projectPlugin,
  ]);
  const disabled = compose("talk-live-verification");
  assert.equal(disabled.status, 1);
  assert.match(disabled.stderr, /talk-live-verification/);
});
