import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listTasks, storeFor, withDriver } from "../workflow-store.mjs";

function setup(t, local = false) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "workflow-store-"));
  const project = join(root, "project");
  const stateDir = join(root, "state");
  const saved = process.env.AGENT_HARNESS_STATE_DIR;
  if (local) delete process.env.AGENT_HARNESS_STATE_DIR;
  else process.env.AGENT_HARNESS_STATE_DIR = stateDir;
  mkdirSync(project);
  t.after(() => {
    if (saved === undefined) delete process.env.AGENT_HARNESS_STATE_DIR;
    else process.env.AGENT_HARNESS_STATE_DIR = saved;
    rmSync(root, { recursive: true, force: true });
  });
  return { root, project, stateDir, store: storeFor(project, "one") };
}

test("由真实项目路径隔离私有状态，ID 安全，版本递增，列表支持续接", t => {
  const { root, project, stateDir, store } = setup(t);
  const other = join(root, "other");
  mkdirSync(other);
  const alias = join(root, "alias");
  symlinkSync(project, alias, "dir");
  assert.deepEqual(listTasks(alias), []);
  for (const id of ["", "../x", "a/b", ".x", "a".repeat(81)]) assert.throws(() => storeFor(project, id));
  assert.throws(() => store.read(), { code: "ENOENT" });
  assert.throws(() => store.create({ seq: 1 }), /序号/);
  assert.throws(() => store.create({ toJSON: () => ({ id: "other", seq: 0 }) }), /JSON/);
  const initial = store.create({ objective: "目标", phase: "design" });
  assert.deepEqual(initial, { id: "one", seq: 0, project, objective: "目标", phase: "design" });
  assert.deepEqual(storeFor(alias, "one").read(), initial);
  assert.throws(() => store.create({}), { code: "ECONFLICT" });
  assert.throws(() => store.commit(0, { ...initial, seq: 2 }), /序号/);
  store.commit(0, { ...initial, seq: 1, phase: "accept" });
  assert.throws(() => store.commit(0, {}), { code: "ECONFLICT" });
  assert.deepEqual(listTasks(project), [{ id: "one", seq: 1, objective: "目标", phase: "accept" }]);
  assert.deepEqual(listTasks(other), []);
  storeFor(project, "One").create({});
  assert.deepEqual(listTasks(project).map(task => task.id), ["One", "one"]);
  if (process.getuid) {
    assert.equal(statSync(stateDir).mode & 0o777, 0o700);
    assert.equal(statSync(store.directory).mode & 0o777, 0o700);
    assert.equal(statSync(join(store.directory, "state", "000000000000.json")).mode & 0o777, 0o600);
    chmodSync(stateDir, 0o755);
    assert.throws(() => store.read(), /独占/);
  }
});

test("忽略未发布文件，拒绝损坏的旧记录和中断的版本链", t => {
  const { store, project } = setup(t);
  store.create({ phase: "initial" });
  store.commit(0, {});
  store.commit(1, {});
  const directory = join(store.directory, "state");
  writeFileSync(join(directory, ".pending-interrupted-process"), "{");
  assert.equal(store.read().seq, 2);
  const old = join(directory, readdirSync(directory).find(name => name.endsWith(".json")));
  const content = readFileSync(old, "utf8");
  writeFileSync(old, content.replace("initial", "changed"));
  assert.throws(() => store.read(), /损坏/);
  assert.throws(() => store.commit(2, {}), /损坏/);
  assert.throws(() => store.create({}), /损坏/);
  assert.throws(() => listTasks(project), /损坏/);
  writeFileSync(old, content);
  unlinkSync(join(directory, "000000000001.json"));
  assert.throws(() => store.read(), /损坏/);
});

// 子进程先读取版本或准备抢占，收到父进程的 IPC 消息后同时起跑。
function child(t, project, action) {
  const source = `
    import { once } from "node:events";
    import { storeFor, withDriver } from ${JSON.stringify(new URL("../workflow-store.mjs", import.meta.url).href)};
    const store = storeFor(process.argv[1], "one");
    const action = process.argv[2];
    const snapshot = action === "commit" ? store.read() : null;
    const go = once(process, "message");
    process.send("ready");
    await go;
    try {
      if (action === "commit") store.commit(snapshot.seq, { winner:process.pid });
      else if (action === "create") store.create({ winner:process.pid });
      else {
        await withDriver(store, async () => {
          const release = once(process, "message");
          process.send("acquired");
          await release;
        });
      }
      process.send("ok");
    } catch (error) {
      process.send(error.code || error.message);
    }
    process.disconnect();
  `;
  const proc = spawn(process.execPath, ["--input-type=module", "-e", source, project, action], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  t.after(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL"); });
  return {
    proc,
    ready: once(proc, "message").then(([message]) => assert.equal(message, "ready")),
    send() {
      const response = once(proc, "message").then(([message]) => message);
      proc.send("go");
      return response;
    },
  };
}

test("并发建任务和提交各只有一个进程胜出", { timeout: 10000 }, async t => {
  const { project, store } = setup(t, true);
  for (const action of ["create", "commit"]) {
    const children = [child(t, project, action), child(t, project, action)];
    await Promise.all(children.map(proc => proc.ready));
    const results = await Promise.all(children.map(proc => proc.send()));
    assert.deepEqual([...results].sort(), ["ECONFLICT", "ok"]);
    assert.equal(store.read().winner, children[results.indexOf("ok")].proc.pid);
    assert.equal(store.read().seq, action === "create" ? 0 : 1);
  }
});

test("驱动在整个回调期间排他，死进程只能被一个竞争者接手", { timeout: 10000 }, async t => {
  const { project, store } = setup(t);
  store.create({});
  const first = child(t, project, "driver");
  await first.ready;
  assert.equal(await first.send(), "acquired");
  await assert.rejects(withDriver(store, () => assert.fail("持有中")), { code: "EBUSY" });
  const dead = once(first.proc, "exit");
  first.proc.kill("SIGKILL");
  await dead;
  const children = [child(t, project, "driver"), child(t, project, "driver")];
  await Promise.all(children.map(proc => proc.ready));
  const results = await Promise.all(children.map(proc => proc.send()));
  assert.deepEqual([...results].sort(), ["EBUSY", "acquired"]);
  const winner = children[results.indexOf("acquired")];
  assert.equal(await winner.send(), "ok");
  await assert.rejects(withDriver(store, () => { throw new Error("回调失败"); }), /回调失败/);
  assert.equal(await withDriver(store, active => active.read().seq), 0);
});

function git(project, ...args) {
  const result = spawnSync("git", args, { cwd: project, encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("默认状态与项目共存，新进程可续接，Git 工作区及已有文件均保持原状", t => {
  const { project, store } = setup(t, true);
  git(project, "init", "-q");
  const local = join(project, ".agent-harness-state");
  const userIgnore = join(project, ".gitignore");
  writeFileSync(userIgnore, "dist/\n");
  writeFileSync(join(project, "user-notes.txt"), "已有未提交文件");
  const gitStatus = () => git(project, "status", "--porcelain=v1", "--untracked-files=all");
  const before = gitStatus();
  assert.deepEqual(listTasks(project), []);
  assert.throws(() => store.read(), { code: "ENOENT" });
  assert.throws(() => statSync(local), { code: "ENOENT" });
  const initial = store.create({ phase: "plan", objective: "项目内续接" });
  if (process.getuid) assert.equal(statSync(local).mode & 0o777, 0o700);
  assert.ok(store.directory.startsWith(join(local, "tasks") + "/") || process.platform === "win32");
  assert.equal(readFileSync(userIgnore, "utf8"), "dist/\n");
  assert.equal(gitStatus(), before);
  const module = new URL("../workflow-store.mjs", import.meta.url).href;
  const source = `import {storeFor} from ${JSON.stringify(module)};
    console.log(JSON.stringify(storeFor(process.cwd(), "one").read()));`;
  const reader = spawnSync(process.execPath, ["--input-type=module", "-e", source], { cwd: project, encoding: "utf8" });
  assert.equal(reader.status, 0, reader.stderr);
  assert.deepEqual(JSON.parse(reader.stdout), initial);
});

test("已有同名目录、普通忽略文件和链接不会被接管", t => {
  const { root, project, store } = setup(t, true);
  const local = join(project, ".agent-harness-state");
  mkdirSync(local, { mode: 0o700 });
  writeFileSync(join(local, "user-data"), "我的数据");
  assert.throws(() => listTasks(project), /专属标记/);
  assert.throws(() => store.create({}), /专属标记/);
  writeFileSync(join(local, ".gitignore"), "*\n");
  assert.throws(() => store.create({}), /专属标记/);
  assert.equal(readFileSync(join(local, ".gitignore"), "utf8"), "*\n");
  assert.equal(readFileSync(join(local, "user-data"), "utf8"), "我的数据");
  assert.deepEqual(readdirSync(local).sort(), [".gitignore", "user-data"]);
  rmSync(local, { recursive: true });
  const other = join(root, "unrelated");
  mkdirSync(other, { mode: 0o700 });
  symlinkSync(other, local, "dir");
  assert.throws(() => store.create({}), /独占/);
  assert.deepEqual(readdirSync(other), []);
});

test("索引中已跟踪的私有状态会阻止后续读写，即使工作树文件已移除", t => {
  const { project, store } = setup(t, true);
  git(project, "init", "-q");
  store.create({ phase: "plan" });
  const history = join(store.directory, "state", "000000000000.json");
  git(project, "add", "-f", "--", history);
  assert.throws(() => store.read(), /Git 已跟踪/);
  assert.throws(() => store.commit(0, {}), /Git 已跟踪/);
  assert.throws(() => listTasks(project), /Git 已跟踪/);
  unlinkSync(history);
  assert.throws(() => storeFor(project, "two").create({}), /Git 已跟踪/);
  assert.deepEqual(readdirSync(join(store.directory, "state")), []);
});

test("显式目录保持按项目隔离，与默认项目状态可独立读取", t => {
  const { project, stateDir, store } = setup(t, true);
  store.create({ origin: "local" });
  process.env.AGENT_HARNESS_STATE_DIR = stateDir;
  assert.deepEqual(listTasks(project), []);
  const external = storeFor(project, "one");
  external.create({ origin: "external" });
  assert.equal(external.read().origin, "external");
  assert.equal(readdirSync(stateDir).length, 1);
  assert.match(readdirSync(stateDir)[0], /^[a-f0-9]{64}$/);
  delete process.env.AGENT_HARNESS_STATE_DIR;
  assert.equal(storeFor(project, "one").read().origin, "local");
});

test("只读项目创建失败且不转存其他目录", { skip: !process.getuid || process.getuid() === 0 }, t => {
  const { project, store, stateDir } = setup(t, true);
  chmodSync(project, 0o500);
  try {
    assert.throws(() => store.create({}), error => ["EACCES", "EPERM", "EROFS"].includes(error.code));
    assert.throws(() => statSync(stateDir), { code: "ENOENT" });
    assert.deepEqual(readdirSync(project), []);
  } finally { chmodSync(project, 0o700); }
});

for (const change of ["复制", "重命名"]) {
  test(change + "了项目的旧任务不进入驱动，当前项目可独立创建并列出新任务", async t => {
    const { root, project, store } = setup(t, true);
    const initial = store.create({ phase: "plan", objective: "仅在原项目执行" });
    const moved = join(root, "new-location");
    if (change === "复制") cpSync(project, moved, { recursive: true });
    else renameSync(project, moved);
    const foreign = storeFor(moved, "one");
    const mismatch = { code: "EPROJECTMISMATCH" };
    assert.deepEqual(listTasks(moved), []);
    assert.throws(() => foreign.read(), mismatch);
    assert.throws(() => foreign.create({}), mismatch);
    assert.throws(() => foreign.commit(initial.seq, { seq: 1 }), mismatch);
    let ran = false;
    await assert.rejects(withDriver(foreign, () => { ran = true; }), mismatch);
    assert.equal(ran, false);
    assert.deepEqual(readdirSync(foreign.directory), ["state"]);
    const fresh = storeFor(moved, "fresh");
    const local = fresh.create({ phase: "plan", objective: "当前项目" });
    assert.equal(local.project, moved);
    assert.deepEqual(listTasks(moved), [{ id: "fresh", seq: 0, phase: "plan", objective: "当前项目" }]);
    assert.throws(() => fresh.commit(0, { project }), mismatch);
    assert.equal(fresh.read().seq, 0);
    if (change === "重命名") renameSync(moved, project);
    assert.deepEqual(store.read(), initial);
  });
}

test("初始状态核对仓库归属，将指向同一项目的别名规范化", t => {
  const { root, project, store } = setup(t, true);
  const alias = join(root, "alias");
  symlinkSync(project, alias, "dir");
  assert.throws(() => store.create({ project: root }), { code: "EPROJECTMISMATCH" });
  assert.deepEqual(readdirSync(project), []);
  assert.equal(store.create({ project: alias }).project, project);
  assert.equal(storeFor(alias, "one").read().project, project);
  assert.equal(store.commit(0, { object: "next" }).project, project);
});
