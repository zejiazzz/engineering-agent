import { createHash } from 'node:crypto';
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, readSync, realpathSync, statSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const statuses = new Set(['passed', 'failed', 'blocked', 'pending', 'waived']);

function requireInput(condition, message) {
  if (!condition) throw new Error(message);
}

function fileIdentity(stat) {
  return `${stat.dev}:${stat.ino}`;
}

/** 文件门禁和工作流共享普通文件与 UTF-8 输入约束。 */
export function readJson(file, label) {
  let descriptor;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
    requireInput(fstatSync(descriptor).isFile(), '需要普通文件');
    const source = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(descriptor));
    return JSON.parse(source);
  } catch {
    throw new Error(`${label} 必须是可读取的 UTF-8 JSON 普通文件`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

// 指纹只覆盖验收语义，忽略检查点与证据键的排列顺序以及附加说明。
function preparePlan(plan) {
  requireInput(object(plan) && Array.isArray(plan.checks) && plan.checks.length,
    'plan.checks 必须是非空数组');
  const checks = new Map();
  for (const [index, row] of plan.checks.entries()) {
    const field = `plan.checks[${index}]`;
    requireInput(object(row) && nonempty(row.id), `${field}.id 必须是非空字符串`);
    const { id, expected, procedure, evidence } = row;
    requireInput(!checks.has(id), `${field}.id 重复：${id}`);
    requireInput(nonempty(expected), `${field}.expected 必须是非空字符串`);
    requireInput(Array.isArray(evidence) && evidence.length && [...evidence].every(nonempty),
      `${field}.evidence 必须包含非空的证据键`);
    requireInput(new Set(evidence).size === evidence.length, `${field}.evidence 含重复证据键`);
    requireInput(procedure === undefined || nonempty(procedure),
      `${field}.procedure 必须描述前置条件和步骤，或提供其来源指纹`);
    checks.set(id, { id, expected, procedure, evidence: evidence.slice().sort() });
  }
  const canonical = { checks: [...checks.keys()].sort().map(id => checks.get(id)) };
  const planId = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  return { checks, planId };
}

/** 校验计划并返回其验收语义的 SHA-256，供项目适配器绑定结果记录。 */
export function planIdFor(plan) {
  return preparePlan(plan).planId;
}

function inside(root, file) {
  const path = relative(root, file);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** 排除私有状态及其别名。仅多硬链接普通文件需要遍历比对元数据。 */
export function isPrivateFile(root, target, stat) {
  if (inside(root, target)) return true;
  const candidate = stat || statSync(target, { bigint: true });
  if (!candidate.isFile() || candidate.nlink < 2n) return false;
  const directories = [root];
  while (directories.length) {
    const directory = directories.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) directories.push(path);
      if (!entry.isFile()) continue;
      const item = lstatSync(path, { bigint: true, throwIfNoEntry: false });
      if (item && fileIdentity(item) === fileIdentity(candidate)) return true;
    }
  }
  return false;
}

// 先核对路径和符号链接的实际目标，再从普通文件读取一个字节验证可读性。
function evidenceProblem(root, value, manifests, inspect, excludeRoots = []) {
  if (!nonempty(value)) return '缺少证据相对路径';
  if (isAbsolute(value) || win32.isAbsolute(value) || /^[A-Za-z]:/.test(value))
    return '证据必须使用结果目录内的相对路径';
  const path = resolve(root, value);
  if (!inside(root, path)) return '证据路径超出结果目录';
  let descriptor;
  let inspecting = false;
  try {
    // 保留原始分段交给文件系统解析，避免消去链接后面的 ".." 而验错文件。
    const target = realpathSync.native(`${root}${sep}${value}`);
    if (!inside(root, target)) return '证据链接超出结果目录';
    if (!statSync(target).isFile()) return '证据必须是普通文件';
    descriptor = openSync(target, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor, { bigint: true });
    if (!stat.isFile()) return '证据必须是普通文件';
    if (excludeRoots.some(dir => isPrivateFile(dir, target, stat))) return '工作流状态目录不能作为实测证据';
    // 同一输入文件即使换名或经硬链接引用，也不能充当独立实测附件。
    if (manifests.has(fileIdentity(stat))) return '计划或结果清单本身不能作为实测证据';
    if (!readSync(descriptor, Buffer.alloc(1), 0, 1, 0)) return '证据文件为空';
    if (inspect) {
      inspecting = true;
      inspect(descriptor, stat);
    }
  } catch (error) {
    if (inspecting) throw error;
    return '证据文件不存在或不可读取';
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** 归档前按同一门禁重新打开附件，在已验证的文件描述符上读取。 */
export function withEvidenceFile(evidenceRoot, path, excludeFiles, inspect, excludeRoots) {
  const root = realpathSync.native(evidenceRoot);
  const manifests = new Set(excludeFiles.map(file => fileIdentity(statSync(file, { bigint: true }))));
  const reason = evidenceProblem(root, path, manifests, inspect, excludeRoots);
  if (reason) throw new Error(reason);
}

/** 文件命令和项目适配器共用此判定。证据相对于 evidenceRoot，excludeFiles 排除清单自证。 */
export function verifyAcceptance(plan, results, { revision, evidenceRoot, excludeFiles = [], excludeRoots = [] }) {
  const { checks, planId } = preparePlan(plan);
  requireInput(nonempty(revision), 'revision 必须是非空字符串');
  requireInput(object(results) && Array.isArray(results.checks), 'results.checks 必须是数组');
  requireInput(nonempty(results.planId) && nonempty(results.revision),
    'results.planId 和 results.revision 必须是非空字符串');
  requireInput(nonempty(evidenceRoot), 'evidenceRoot 必须是有效的目录路径');
  const root = realpathSync.native(evidenceRoot);
  requireInput(statSync(root).isDirectory(), 'evidenceRoot 必须是目录');
  requireInput(Array.isArray(excludeFiles), 'excludeFiles 必须是数组');
  const manifests = new Set();
  for (const file of excludeFiles) {
    requireInput(nonempty(file) && isAbsolute(file), 'excludeFiles 必须使用绝对路径');
    const stat = statSync(file, { bigint: true });
    requireInput(stat.isFile(), 'excludeFiles 必须指向普通文件');
    manifests.add(fileIdentity(stat));
  }
  const issues = [];
  const observedFailures = [];
  const duplicates = new Set();
  let invalid = false;
  if (results.planId !== planId) issues.push({ reason: 'planId 与当前计划不符' });
  if (results.revision !== revision) issues.push({ reason: 'revision 与当前版本不符' });
  const seen = new Set();
  for (const [index, row] of results.checks.entries()) {
    const field = `results.checks[${index}]`;
    if (!object(row) || !nonempty(row.id)) {
      invalid = true;
      issues.push({ reason: `${field}.id 必须是非空字符串` });
      continue;
    }
    const { id, status, actual, evidence } = row;
    if (seen.has(id)) {
      issues.push({ id, reason: '结果中重复出现此检查点' });
      duplicates.add(id);
    }
    seen.add(id);
    const check = checks.get(id);
    if (!check) issues.push({ id, reason: '计划范围外的检查点' });
    if (!statuses.has(status)) {
      invalid = true;
      issues.push({ id, reason: `${field}.status 缺失或未知` });
      continue;
    }
    if (status !== 'passed') {
      issues.push({ id, reason: `检查点状态为 ${status}` });
      if (status !== 'failed') continue;
    }
    // 失败可以触发返工，前提是它与通过项一样有独立、可读取的实测材料。
    const beforeEvidence = issues.length;
    if (!nonempty(actual)) issues.push({ id, reason: '缺少非空的实际观察 actual' });
    if (!check) continue;
    for (const key of check.evidence) {
      const value = object(evidence) && Object.hasOwn(evidence, key) ? evidence[key] : undefined;
      const reason = evidenceProblem(root, value, manifests, undefined, excludeRoots);
      if (reason) issues.push({ id, key, reason });
    }
    if (status === 'failed' && issues.length === beforeEvidence) observedFailures.push(id);
  }
  for (const id of checks.keys()) {
    if (!seen.has(id)) issues.push({ id, reason: '缺少此检查点的结果' });
  }
  const passed = issues.length === 0;
  const failedChecks = !invalid && results.planId === planId && results.revision === revision
    ? observedFailures.filter(id => !duplicates.has(id)) : [];
  return {
    passed, planId, revision, planned: checks.size, reported: results.checks.length,
    issues, failedChecks, exitCode: invalid ? 2 : passed ? 0 : 1,
  };
}

function runCli([command, ...args]) {
  try {
    if (command === 'plan-id' && args.length === 1) {
      console.log(planIdFor(readJson(args[0], 'plan')));
    } else if (command === 'check' && args.length === 4 && args[2] === '--revision' && nonempty(args[3])) {
      const [planFile, resultFile] = args.slice(0, 2).map(file => resolve(file));
      const report = verifyAcceptance(readJson(planFile, 'plan'), readJson(resultFile, 'results'), {
        revision: args[3], evidenceRoot: dirname(resultFile), excludeFiles: [planFile, resultFile],
      });
      console.log(JSON.stringify(report));
      process.exitCode = report.exitCode;
    } else {
      throw new Error('用法：node verify.mjs plan-id PLAN.json 或 node verify.mjs check PLAN.json RESULTS.json --revision CURRENT');
    }
  } catch (error) {
    if (command === 'check') {
      console.log(JSON.stringify({ passed: false, issues: [{ reason: error.message }], exitCode: 2 }));
    } else {
      console.error(error.message);
    }
    process.exitCode = 2;
  }
}

// Node 16 尚无 import.meta.main。兼容符号链接启动和没有主文件的 stdin/eval。
function isCliEntry() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isCliEntry()) runCli(process.argv.slice(2));
