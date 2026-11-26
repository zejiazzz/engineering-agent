import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../verify.mjs", import.meta.url));
const revision = "snapshot-2";

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "engineering-agent-verify-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const resultDir = join(root, "run");
  const artifacts = join(resultDir, "artifacts");
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, "screen.txt"), "View after saving");
  writeFileSync(join(artifacts, "log.txt"), "Save succeeded");
  const planPath = join(resultDir, "plan.json");
  const resultsPath = join(resultDir, "results.json");
  const plan = {
    checks: [
      { id: "display", expected: "Saved title visible", evidence: ["screen", "log"] },
      { id: "save", expected: "Save succeeded", evidence: ["log"] },
    ],
  };
  const writePlan = (value) => writeFileSync(planPath, JSON.stringify(value));
  writePlan(plan);

  function run(...args) {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result;
  }

  function planId() {
    const result = run("plan-id", planPath);
    assert.equal(result.status, 0, result.stderr);
    const id = result.stdout.trim();
    assert.match(id, /^[0-9a-f]{64}$/);
    return id;
  }

  function completed() {
    return {
      planId: planId(),
      revision,
      checks: [
        { id: "save", status: "passed", actual: "Save succeeded", evidence: { log: "artifacts/log.txt" } },
        {
          id: "display",
          status: "passed",
          actual: "After saving, the screen displayed the new title",
          evidence: { log: "artifacts/log.txt", screen: "artifacts/screen.txt" },
        },
      ],
    };
  }
  function check(results) {
    writeFileSync(resultsPath, JSON.stringify(results));
    return run("check", planPath, resultsPath, "--revision", revision);
  }
  return { artifacts, root, plan, planPath, resultsPath, run, writePlan, planId, completed, check };
}

test("plan-id identifies acceptance requirements regardless of ordering and extra metadata", (t) => {
  const f = setup(t);
  const original = f.planId();
  f.writePlan({
    owner: "release",
    checks: [
      { ...f.plan.checks[1], note: "internal tracking" },
      { evidence: ["log", "screen"], expected: "Saved title visible", id: "display" },
    ],
  });
  assert.equal(f.planId(), original);
  for (const change of [{ expected: "New title visible" }, { evidence: ["screen"] }, { id: "title" }]) {
    f.writePlan({ checks: [{ ...f.plan.checks[0], ...change }, f.plan.checks[1]] });
    assert.notEqual(f.planId(), original, JSON.stringify(change));
  }
});

test("plan-id rejects empty plans and duplicate check ids", (t) => {
  const f = setup(t);
  for (const checks of [[], [f.plan.checks[0], f.plan.checks[0]]]) {
    f.writePlan({ checks });
    assert.equal(f.run("plan-id", f.planPath).status, 2);
  }
});

test("check accepts every planned result once, with shared evidence relative to the results file", (t) => {
  const f = setup(t);
  const result = f.check(f.completed());
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.passed, true);
  assert.deepEqual(report.issues, []);
});

test("check rejects omitted, duplicated and unplanned result ids", (t) => {
  const f = setup(t);
  const results = f.completed();
  const [save, display] = results.checks;
  const unplanned = { ...save, id: "extra" };
  for (const [checks, expectedIds] of [
    [[], ["save", "display"]],
    [[display], ["save"]],
    [[save, save], ["save", "display"]],
    [[save, display, save], ["save"]],
    [[save, display, unplanned], ["extra"]],
  ]) {
    const result = f.check({ ...results, checks });
    assert.notEqual(result.status, 0, JSON.stringify(checks));
    const report = JSON.parse(result.stdout);
    assert.equal(report.passed, false);
    for (const id of expectedIds) {
      assert.ok(report.issues.some((issue) => issue.id === id && issue.reason), id);
    }
  }
});

test("failed, pending, blocked and waived checks prevent an all-passed verdict", (t) => {
  const f = setup(t);
  const results = f.completed();
  for (const status of ["failed", "pending", "blocked", "waived"]) {
    results.checks[0].status = status;
    assert.equal(f.check(results).status, 1, status);
  }
});

test("a passed status requires a nonblank observation and all named evidence", (t) => {
  const f = setup(t);
  const results = f.completed();
  const [save, display] = results.checks;
  for (const partial of [
    { actual: undefined }, { actual: " \t " }, { evidence: undefined },
    { evidence: { log: "artifacts/log.txt" } },
    { evidence: { ...display.evidence, screen: "" } },
  ]) {
    assert.notEqual(f.check({ ...results, checks: [save, { ...display, ...partial }] }).status, 0);
  }
});

test("evidence must resolve to a nonempty regular file within the results directory", (t) => {
  const f = setup(t);
  const results = f.completed();
  writeFileSync(join(f.artifacts, "empty.txt"), "");
  const outside = join(f.root, "outside.txt");
  writeFileSync(outside, "outside the run");
  symlinkSync(outside, join(f.artifacts, "outside-link.txt"), "file");
  for (const path of [
    "artifacts/absent.txt", "artifacts/empty.txt", "artifacts",
    "../outside.txt", "artifacts/outside-link.txt", outside,
  ]) {
    results.checks[1].evidence.screen = path;
    const result = f.check(results);
    assert.notEqual(result.status, 0, path);
    const { passed, issues } = JSON.parse(result.stdout);
    assert.equal(passed, false);
    assert.ok(issues.some(({ id, key, reason }) => id === "display" && key === "screen" && reason), path);
  }
});

test("the plan and the current results cannot act as their own execution evidence", (t) => {
  const f = setup(t);
  const results = f.completed();
  symlinkSync(f.planPath, join(f.artifacts, "plan-link.json"), "file");
  for (const path of ["plan.json", "results.json", "artifacts/plan-link.json"]) {
    results.checks[1].evidence.screen = path;
    assert.notEqual(f.check(results).status, 0, path);
  }
});

test("stored results cannot satisfy a different revision or a modified plan", (t) => {
  const f = setup(t);
  const results = f.completed();
  assert.notEqual(f.check({ ...results, revision: "snapshot-1" }).status, 0);
  f.plan.checks[0].expected = "Renamed title visible";
  f.writePlan(f.plan);
  assert.notEqual(f.check(results).status, 0);
});

test("invalid calls and malformed input files return exit code 2", (t) => {
  const f = setup(t);
  f.check(f.completed());
  assert.equal(f.run("check", f.planPath, f.resultsPath).status, 2);
  assert.equal(f.run("unknown").status, 2);
  writeFileSync(f.resultsPath, "{");
  assert.equal(f.run("check", f.planPath, f.resultsPath, "--revision", revision).status, 2);
  writeFileSync(f.planPath, "{");
  assert.equal(f.run("plan-id", f.planPath).status, 2);
});

test("changing the actor or steps invalidates an otherwise identical observation", (t) => {
  const f = setup(t);
  f.plan.checks[0].procedure = "Admin opens the saved item from the list";
  f.writePlan(f.plan);
  const results = f.completed();
  assert.equal(f.check(results).status, 0);
  f.plan.checks[0].procedure = "Guest opens the saved item from the list";
  f.writePlan(f.plan);
  const after = f.check(results);
  assert.equal(after.status, 1);
  assert.ok(JSON.parse(after.stdout).issues.some(issue => issue.reason.includes("planId")));
});
