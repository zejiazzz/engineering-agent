import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, unlinkSync, writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";

const safeId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const digest = value => createHash("sha256").update(value).digest("hex");
const conflict = () => Object.assign(new Error("任务已有新版本，请重新读取。"), { code: "ECONFLICT" });
const corrupt = path => new Error(`任务历史损坏，请检查 ${path}`);
const localName = ".agent-harness-state";
const localMarker = "# engineering-agent-harness private state v1\n*\n";

function projectMismatch(expected, actual) {
  return Object.assign(new Error(
    `任务绑定的项目为 ${expected}，当前项目为 ${actual}。请在原项目路径续跑，或在新位置用新 ID 开始任务。`
  ), { code: "EPROJECTMISMATCH" });
}

function privateDirectory(path, create) {
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || (process.getuid &&
      (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) {
    throw new Error(`需要当前用户独占的状态目录（0700）：${path}`);
  }
}

function namespace(project) {
  const path = realpathSync(project);
  if (!lstatSync(path).isDirectory()) throw new Error("项目路径必须是目录。");
  if (process.env.AGENT_HARNESS_STATE_DIR) {
    const root = resolve(process.env.AGENT_HARNESS_STATE_DIR);
    return { root, group: join(root, digest(path)), project: path, local: false };
  }
  const root = join(path, localName);
  return { root, group: join(root, "tasks"), project: path, local: true };
}

function insideGitWorktree(project) {
  for (let path = project; ; path = dirname(path)) {
    try { lstatSync(join(path, ".git")); return true; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (dirname(path) === path) return Boolean(process.env.GIT_DIR);
  }
}

function rejectTracked(project) {
  if (!insideGitWorktree(project)) return;
  const git = spawnSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false",
    "ls-files", "--cached", "-z", "--", localName], { cwd: project, encoding: "utf8" });
  if (git.error || git.status !== 0) throw new Error("无法核对项目 Git 索引中的私有状态目录");
  if (git.stdout) throw new Error(`Git 已跟踪 ${localName} 中的路径，无法将其用作私有状态目录`);
}

function validateMarker(root, creating) {
  const marker = join(root, ".gitignore");
  const deadline = Date.now() + (creating ? 250 : 0);
  for (;;) {
    try {
      const stat = lstatSync(marker);
      if (stat.isFile() && stat.nlink === 1 && stat.size === Buffer.byteLength(localMarker) &&
          readFileSync(marker, "utf8") === localMarker) return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    // 另一创建者可能刚刚独占创建目录，尚未完成标记写入。观察方始终只读。
    if (Date.now() >= deadline) throw new Error(
      `已有同名目录缺少有效的研发任务专属标记：${root}。若此前初始化中断，确认无运行任务后可将该目录移到项目外保存，再重试。`
    );
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

function prepareRoot({ root, project, local }, create) {
  const actual = realpathSync(project);
  if (actual !== project) throw projectMismatch(project, actual);
  if (!local) return privateDirectory(root, create);
  rejectTracked(project);
  if (create) {
    let created = false;
    try { mkdirSync(root, { mode: 0o700 }); created = true; }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    if (created) {
      // 只为本调用新建的根写标记，保留同名的项目原有目录及其全部内容。
      const fd = openSync(join(root, ".gitignore"), "wx", 0o600);
      try { writeFileSync(fd, localMarker); fsyncSync(fd); } finally { closeSync(fd); }
    }
  }
  privateDirectory(root, false);
  validateMarker(root, create);
}

function fileName(index) {
  return String(index).padStart(12, "0") + ".json";
}

// 只发布已完整落盘的文件。link 的目标不可覆盖，两个写者只能有一个赢得同一序号。
function publish(directory, index, previous, value) {
  if (index >= 1e12) throw new Error("任务历史已超出可用序号。");
  const entry = [1, index, previous, value];
  const hash = digest(JSON.stringify(entry));
  const data = JSON.stringify({ entry, hash }) + "\n";
  const pending = join(directory, ".pending-" + randomUUID());
  const fd = openSync(pending, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(pending, join(directory, fileName(index)));
    } catch (error) {
      if (error.code === "EEXIST") throw conflict();
      throw error;
    }
    if (process.platform !== "win32") {
      const dirFd = openSync(directory, "r");
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    }
  } finally {
    unlinkSync(pending);
  }
  return { index, hash, value };
}

// 每次从版本零校验连续序号、校验和以及前序摘要。崩溃留下的未发布文件不参与读取。
function lastRecord(directory, validate) {
  const names = readdirSync(directory).filter(name => !name.startsWith(".pending-")).sort();
  let last = null;
  for (const [index, name] of names.entries()) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (name !== fileName(index) || !stat.isFile() || (process.getuid &&
        (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) throw corrupt(path);
    const text = readFileSync(path, "utf8");
    try {
      const { entry, hash } = JSON.parse(text);
      if (!Array.isArray(entry) || entry.length !== 4) throw corrupt(path);
      if (digest(JSON.stringify(entry)) !== hash) throw corrupt(path);
      const [format, ordinal, previous, value] = entry;
      if (format !== 1 || ordinal !== index || previous !== (last?.hash ?? null) ||
          !validate(value, index, last?.value)) throw corrupt(path);
      last = { index, hash, value };
    } catch (error) {
      if (error.code === "EPROJECTMISMATCH") throw error;
      throw corrupt(path);
    }
  }
  return last;
}

function taskState(input, id, seq, project) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      ("id" in input && input.id !== id) || ("seq" in input && input.seq !== seq)) {
    throw new Error(`任务状态需要匹配 ID ${id} 和序号 ${seq}。`);
  }
  // 以实际可持久化的 JSON 快照作为返回值，并在发布前核对序列化后的身份。
  const snapshot = JSON.parse(JSON.stringify({ ...input, id, seq }));
  if (snapshot?.id !== id || snapshot.seq !== seq) throw new Error("任务状态无法保存为匹配的 JSON 快照。");
  if ("project" in snapshot && snapshot.project !== project) {
    let bound;
    try { bound = realpathSync(snapshot.project); }
    catch { throw projectMismatch(String(snapshot.project), project); }
    if (bound !== project) throw projectMismatch(bound, project);
  }
  // 即便调用者仅提交业务字段，持久化快照也始终绑定规范化后的项目根。
  snapshot.project = project;
  return snapshot;
}

const drivers = new WeakMap();

/** 以实际项目路径和任务 ID 定位私有历史；写入者必须提供它读取时的序号。 */
export function storeFor(project, id) {
  if (typeof id !== "string" || !safeId.test(id)) throw new Error("任务 ID 格式无效。");
  const location = namespace(project);
  const { group } = location;
  // 十六进制目录名也能在大小写不敏感的文件系统上区分任务，并避开系统保留名称。
  const directory = join(group, "task-" + Buffer.from(id).toString("hex"));
  function journal(name, create) {
    const path = join(directory, name);
    prepareRoot(location, create);
    for (const item of [group, directory, path]) privateDirectory(item, create);
    return path;
  }
  function latest(path) {
    return lastRecord(path, (state, index) => {
      if (state?.id !== id || state.seq !== index) return false;
      if (state.project !== location.project) throw projectMismatch(state.project, location.project);
      return true;
    });
  }
  function required(last) {
    if (!last) throw Object.assign(new Error(`找不到任务 ${id}。`), { code: "ENOENT" });
    return last;
  }
  const store = {
    directory,
    create(initial) {
      const state = taskState(initial, id, 0, location.project);
      const path = journal("state", true);
      if (latest(path)) throw conflict();
      return publish(path, 0, null, state).value;
    },
    read() {
      return required(latest(journal("state", false))).value;
    },
    commit(expectedSeq, next) {
      const path = journal("state", false);
      const last = required(latest(path));
      if (last.index !== expectedSeq) throw conflict();
      const state = taskState(next, id, last.index + 1, location.project);
      return publish(path, last.index + 1, last.hash, state).value;
    },
  };
  drivers.set(store, () => {
    store.read();
    return journal("driver", true);
  });
  return store;
}

/** 列出此真实项目已发布的任务。首次写入前崩溃的空任务没有状态。 */
export function listTasks(project) {
  const location = namespace(project);
  const { group } = location;
  let ids;
  try {
    prepareRoot(location, false);
    privateDirectory(group, false);
    ids = readdirSync(group).map(name => {
      if (!/^task-(?:[0-9a-f]{2})+$/.test(name)) throw corrupt(join(group, name));
      const id = Buffer.from(name.slice(5), "hex").toString();
      if (!safeId.test(id) || Buffer.from(id).toString("hex") !== name.slice(5)) throw corrupt(join(group, name));
      return id;
    }).sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const tasks = [];
  for (const id of ids) {
    let state;
    try {
      state = storeFor(project, id).read();
    } catch (error) {
      // 复制项目里的旧任务仍可按 ID 查到定位错误；它不占用当前项目的可续任务清单。
      if (error.code === "ENOENT" || error.code === "EPROJECTMISMATCH") continue;
      throw error;
    }
    tasks.push({ id, phase: state.phase, seq: state.seq, objective: state.objective });
  }
  return tasks;
}

function startIdentity(pid) {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      if (start && boot) return boot + "/" + start;
    } catch { /* 受限宿主仍可使用 PID 探活。 */ }
  } else if (process.platform === "darwin") {
    const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8", timeout: 1000, env: { ...process.env, LC_ALL: "C", TZ: "UTC0" },
    });
    if (result.status === 0) return result.stdout.trim() || null;
  }
  return null;
}

function live(owner) {
  if (owner.host !== hostname()) throw new Error("任务由另一主机持有，请在该主机核对驱动状态。");
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code !== "EPERM") throw error;
  }
  const current = owner.start && startIdentity(owner.pid);
  return !current || current === owner.start;
}

function validDriver(value, index, previous) {
  if (value?.kind === "release") return previous?.kind === "claim" && previous.token === value.token;
  return value?.kind === "claim" && typeof value.token === "string" &&
    Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.host === "string" &&
    (value.start === null || typeof value.start === "string");
}

/** 在整个回调期间独占任务。接管及释放均追加版本，迟到的竞争者不能移除新持有者。 */
export async function withDriver(store, callback) {
  const directory = drivers.get(store)();
  const owner = {
    kind: "claim", token: randomUUID(), pid: process.pid, host: hostname(), start: startIdentity(process.pid),
  };
  let claim;
  for (;;) {
    const last = lastRecord(directory, validDriver);
    if (last?.value.kind === "claim" && live(last.value)) {
      throw Object.assign(new Error(`任务正在由其他驱动处理（PID ${last.value.pid}）。`), { code: "EBUSY" });
    }
    try {
      claim = publish(directory, (last?.index ?? -1) + 1, last?.hash ?? null, owner);
      break;
    } catch (error) {
      if (error.code !== "ECONFLICT") throw error;
    }
  }
  try {
    return await callback(store);
  } finally {
    publish(directory, claim.index + 1, claim.hash, { kind: "release", token: owner.token });
  }
}
