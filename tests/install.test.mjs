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

test("every host installs and upgrades the same shared acceptance entry and runtime", (t) => {
  const original = "# Existing user rules\n\nKeep these instructions.\n";
  const shippedPlugins = [
    "auto-commit.md", "code-review.md", "engineering-diagnostics.md", "feishu-defects.md",
    "frontend", "frontend-standards.md", join("frontend", "design.md"), join("frontend", "structure.md"),
  ].sort();

  for (const [host, files] of Object.entries(hostFiles)) {
    const fixture = setup(t);
    const { root, bundle } = fixture;
    const hostDir = join(root, host);
    const outputs = files.map((file) => join(hostDir, file));
    const preview = JSON.parse(passed(fixture.install(host, "--dry-run")));
    assert.equal(preview.host, host);
    assert.equal(preview.packageDir, bundle);
    assert.deepEqual(preview.files.map(({ path }) => path), outputs);
    assert.equal(preview.nativeReviewer, files.some((file) => file.startsWith("agents/")));
    assert.equal(existsSync(hostDir), false);
    assert.equal(existsSync(dirname(bundle)), false);

    const instruction = files.find((file) => ["AGENTS.md", "CLAUDE.md"].includes(file));
    if (instruction) put(join(hostDir, instruction), original);

    passed(fixture.install(host));
    const written = outputs.map(read);
    for (const config of written) assert.ok(config.includes(bundle));
    assert.ok(written[0].includes("acceptance"));
    const plugins = join(bundle, "plugins");
    assert.deepEqual(readdirSync(plugins, { recursive: true }).sort(), shippedPlugins);
    const core = join(bundle, "core.md");
    const guide = join(bundle, "acceptance.md");
    assert.deepEqual(JSON.parse(passed(fixture.compose())), [core]);
    assert.deepEqual(JSON.parse(passed(fixture.compose("acceptance"))), [core, guide]);
    assert.equal(read(join(bundle, "verify.mjs")), read(new URL("../verify.mjs", import.meta.url)));
    if (instruction) {
      assert.ok(written[0].startsWith(original));
      assert.equal(written[0].split("<!-- business-agent:start -->").length, 2);
    }
    // 模拟上版托管共享包中曾发布、现已移除的专项说明和运行器。
    put(join(plugins, "retired-guide.md"), "Retired workflow");
    put(join(plugins, "retired", "run.cjs"), "Retired runner");
    passed(fixture.install(host));
    assert.deepEqual(outputs.map(read), written);
    assert.deepEqual(readdirSync(plugins, { recursive: true }).sort(), shippedPlugins);
    assert.deepEqual(JSON.parse(passed(fixture.compose("acceptance"))), [core, guide]);

    for (const doc of ["README.md", "INSTALL.md", "CONTRIBUTING.md", "LICENSE"]) {
      assert.equal(read(join(bundle, doc)), read(new URL("../" + doc, import.meta.url)));
    }
  }
});

test("installed core and independent review link to the same shipped acceptance guide", (t) => {
  const { bundle, install } = setup(t);
  passed(install("codex"));
  const guide = join(bundle, "acceptance.md");
  assert.equal(read(guide), read(new URL("../acceptance.md", import.meta.url)));

  for (const entry of ["core.md", "plugins/code-review.md"]) {
    const path = join(bundle, entry);
    const links = [...read(path).matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]*)?\)/g)];
    assert.ok(links.some(([, target]) => join(dirname(path), target) === guide), entry);
  }
});

test("a business project can run the installed verification gate without dependencies", (t) => {
  const { bundle, project, install, run } = setup(t);
  passed(install("codex"));
  const verifier = join(bundle, "verify.mjs");
  const plan = { checks: [{ id: "ui/保存", expected: "回读新标题", evidence: ["回读"] }] };
  put(join(project, "plan.json"), JSON.stringify(plan));
  const planId = passed(run([verifier, "plan-id", "plan.json"])).trim();
  put(join(project, "run", "observation.txt"), "重新进入后标题为春季计划");
  put(join(project, "run", "results.json"), JSON.stringify({
    planId, revision: "build-7",
    checks: [{ id: "ui/保存", status: "passed", actual: "回读到春季计划", evidence: { 回读: "observation.txt" } }],
  }));
  const args = [verifier, "check", "plan.json", "run/results.json", "--revision"];
  assert.equal(JSON.parse(passed(run([...args, "build-7"]))).passed, true);
  const stale = run([...args, "build-8"]);
  assert.equal(stale.status, 1);
  assert.equal(JSON.parse(stale.stdout).passed, false);
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

test("a normal Claude Code upgrade refreshes a managed fallback skill and preserves a user-owned skill", (t) => {
  const { root, install } = setup(t);
  const fallback = join(root, "claude-code", skill);
  passed(install("claude-code", "--bundle-only"));
  const current = read(fallback);
  const previous = current.replace(/^description: .+$/m, "description: Retired workflow");
  assert.notEqual(previous, current);
  put(fallback, previous);
  passed(install("claude-code"));
  assert.equal(read(fallback), current);
  const userSkill = "# Team engineering process\n";
  put(fallback, userSkill);
  passed(install("claude-code"));
  assert.equal(read(fallback), userSkill);
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
    "acceptance",
    "git-delivery",
    "code-review",
    "frontend-standards",
    "engineering-diagnostics",
  ]);
  const acceptance = plugins.find(({ id }) => id === "acceptance");
  assert.equal(acceptance.entry, "acceptance.md");
  for (const trigger of ["用例", "真实验收", "续验", "验收排障"]) {
    assert.ok(acceptance.when.includes(trigger), trigger);
  }
  assert.deepEqual(JSON.parse(passed(compose(...defaultIds))), [
    core,
    ...plugins.map(({ entry }) => join(bundle, entry)),
  ]);

  const profile = join(project, "docs/project.md");
  const adapter = join(project, "docs/acceptance-adapter.md");
  const projectPlugin = join(project, "docs/migration.md");
  for (const path of [profile, adapter, projectPlugin]) put(path, "# Project\n");
  put(join(project, ".agent-harness.json"), JSON.stringify({
    schemaVersion: 1,
    profile: "docs/project.md",
    plugins: [
      { id: "acceptance", when: "Verify this project", adapter: "docs/acceptance-adapter.md" },
      { id: "engineering-diagnostics", enabled: false },
      { id: "migration", when: "Handle a migration", entry: "docs/migration.md" },
    ],
  }));

  assert.deepEqual(JSON.parse(passed(compose())), [core, profile]);
  assert.deepEqual(JSON.parse(passed(compose("migration", "acceptance"))), [
    core,
    profile,
    join(bundle, "acceptance.md"),
    adapter,
    projectPlugin,
  ]);
  const disabled = compose("engineering-diagnostics");
  assert.equal(disabled.status, 1);
  assert.match(disabled.stderr, /engineering-diagnostics/);
});
