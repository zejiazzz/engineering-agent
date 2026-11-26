import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readSync, realpathSync, unlinkSync, writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { planIdFor, readJson, verifyAcceptance, withEvidenceFile } from './verify.mjs';
import {
  checkPlannedSource, currentRevision, inside, manifestIdentity, projectFile, protocolError, sourceFrom,
} from './workflow-revision.mjs';

export { currentRevision };

function requiredText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw protocolError(`${name} 必须是非空字符串`);
  return value;
}

function requirePhase(state, ...phases) {
  if (!phases.includes(state.phase)) {
    throw protocolError(`当前阶段为 ${state.phase}，此事件仅适用于 ${phases.join('/')}`);
  }
}

function stepId(id, seq) {
  return `${id}:${seq}`;
}

/** 创建可直接持久化的任务。相对材料路径始终相对于本次项目目录。 */
export function createTask({ id, objective, project }) {
  requiredText(id, 'id');
  requiredText(objective, 'objective');
  return {
    schemaVersion: 1, id, objective, project: resolve(requiredText(project, 'project')),
    phase: 'plan', seq: 0, stepId: stepId(id, 0), summary: '', plan: null,
    question: null, lastDecision: null, lastTest: null, history: [],
  };
}

/** 返回独立的 JSON 快照，包含检查点、待决问题、人工答复与历次验收记录。 */
export function view(state) {
  return JSON.parse(JSON.stringify(state));
}

// 驱动可能覆盖清单文件。只留存验收契约与实测字段，避免复制无关的项目元数据。
function captureResults(results, snapshot) {
  const keysById = new Map(snapshot.checks.map(check => [check.id, check.evidence]));
  const checks = [];
  for (const row of results.checks) {
    if (!row || typeof row.id !== 'string') continue;
    const keys = keysById.get(row.id) || [];
    const evidence = Object.fromEntries(keys
      .filter(key => typeof row.evidence?.[key] === 'string')
      .map(key => [key, row.evidence[key]]));
    const { id } = row;
    const status = typeof row.status === 'string' ? row.status : null;
    const actual = typeof row.actual === 'string' ? row.actual : null;
    checks.push({ id, status, actual, evidence });
  }
  return { planId: results.planId, revision: results.revision, checks };
}

function privateDirectory(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || (process.getuid && (stat.uid !== process.getuid() || stat.mode & 0o077))) {
    throw new Error('实测归档须使用当前用户独占的任务目录');
  }
}

function privateRootFor(state, directory) {
  const previous = state.plan?.privateRoot || null;
  if (!directory) return previous;
  privateDirectory(directory);
  const task = realpathSync(directory);
  const project = realpathSync(state.project);
  const group = dirname(task);
  const projectHash = createHash('sha256').update(project).digest('hex');
  const taskName = 'task-' + Buffer.from(state.id).toString('hex');
  // storeFor 的目录由真实项目路径和任务 ID 共同界定。独立调用传入的任意私有目录仅隔离自身。
  let root = task;
  const localTasks = join(project, '.agent-harness-state', 'tasks');
  if ((group === localTasks || basename(group) === projectHash) && basename(task) === taskName) {
    const storage = dirname(group);
    root = inside(storage, project) ? group : storage;
  }
  return previous && !inside(root, previous) ? previous : root;
}

function digestFile(input, output) {
  const hash = createHash('sha256');
  const block = Buffer.allocUnsafe(64 * 1024);
  let size = 0;
  let count;
  while ((count = readSync(input, block, 0, block.length, null)) !== 0) {
    hash.update(block.subarray(0, count));
    size += count;
    if (output === undefined) continue;
    let offset = 0;
    while (offset < count) offset += writeSync(output, block, offset, count - offset);
  }
  return { sha256: hash.digest('hex'), size };
}

// 附件先写入私有临时文件，再以摘要为名一次发布。相同内容共享不可覆盖的副本。
function archiveCopy(directory, source, before) {
  const temp = join(directory, `.pending-${randomUUID()}`);
  const output = openSync(temp, 'wx', 0o600);
  try {
    const blob = digestFile(source, output);
    const after = fstatSync(source, { bigint: true });
    if (before.ctimeNs !== after.ctimeNs || before.size !== BigInt(blob.size)) throw new Error('归档时实测附件发生变化');
    fchmodSync(output, 0o400);
    fsyncSync(output);
    const path = join(directory, blob.sha256);
    try {
      linkSync(temp, path);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(previous);
        if (!stat.isFile() || (process.getuid && (stat.uid !== process.getuid() || stat.mode & 0o377)) ||
            digestFile(previous).sha256 !== blob.sha256) throw new Error('已有归档附件损坏');
      } finally { closeSync(previous); }
    }
    return { ...blob, path };
  } finally {
    closeSync(output);
    unlinkSync(temp);
  }
}

function archiveFailures(test, evidenceRoot, excludeFiles, archiveDirectory, privateRoot) {
  if (!archiveDirectory) throw new Error('须提供私有 archiveDirectory 以保留实测失败材料');
  privateDirectory(archiveDirectory);
  const root = realpathSync(archiveDirectory);
  const directory = join(root, 'failed-evidence');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  privateDirectory(directory);
  const retained = [];
  const failures = new Set(test.report.failedChecks);
  for (const row of test.results.checks) {
    if (!failures.has(row.id)) continue;
    for (const [key, path] of Object.entries(row.evidence)) {
      withEvidenceFile(evidenceRoot, path, excludeFiles, (fd, stat) => {
        retained.push({ id: row.id, key, source: path, ...archiveCopy(directory, fd, stat) });
      }, [privateRoot || root]);
    }
  }
  if (process.platform !== 'win32') {
    const dir = openSync(directory, 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  }
  return retained;
}

function inspectTest(state, event, seq, archiveDirectory) {
  const revision = requiredText(event.revision, 'revision');
  const resultsFile = resolve(state.project, requiredText(event.resultsFile, 'resultsFile'));
  const { snapshot, planId, planFile } = state.plan;
  const test = { seq, planId, revision, resultsFile, outcome: 'incomplete', report: null };
  try {
    const privateRoot = privateRootFor(state, archiveDirectory);
    const planTarget = projectFile(state.project, planFile, 'planFile', privateRoot);
    const currentPlan = readJson(planTarget, 'plan');
    const currentPlanId = planIdFor(currentPlan);
    const source = sourceFrom(state.project, currentPlan);
    if (currentPlanId !== planId || JSON.stringify(source) !== JSON.stringify(state.plan.fileRevisionSource ?? null)) {
      return {
        ...test, outcome: 'plan-changed', currentPlanId,
        reason: '计划文件的验收范围已变化。恢复已确认的计划，或说明变更并请求人工批准重新规划。',
      };
    }
    const resultsTarget = projectFile(state.project, resultsFile, 'resultsFile', privateRoot);
    const results = readJson(resultsTarget, 'results');
    test.manifestIdentity = manifestIdentity(resultsTarget);
    test.currentRevision = currentRevision(state, resultsFile, privateRoot);
    if (revision !== test.currentRevision) throw new Error('tested.revision 与独立取得的当前版本不符，请重新实测');
    const evidenceRoot = dirname(resultsTarget);
    const sources = state.plan.revisionSource;
    const sourceFiles = (sources.revisionInputs || [sources.revisionFile]).map(path => projectFile(
      state.project, resolve(state.project, path), '版本来源', privateRoot));
    const excludeFiles = [planTarget, resultsTarget, ...sourceFiles];
    test.report = verifyAcceptance(snapshot, results, {
      revision: test.currentRevision, evidenceRoot, excludeFiles, excludeRoots: privateRoot ? [privateRoot] : [],
    });
    test.results = captureResults(results, snapshot);
    if (test.report.failedChecks.length) {
      test.archivedEvidence = archiveFailures(test, evidenceRoot, excludeFiles, archiveDirectory, privateRoot);
    }
    if (currentRevision(state, resultsFile, privateRoot) !== test.currentRevision) throw new Error('验收过程中版本发生变化，请重新实测');
    if (test.report.exitCode === 0) test.outcome = 'passed';
    else if (test.report.failedChecks.length) test.outcome = 'failed';
  } catch (error) {
    test.reason = error.message;
  }
  return test;
}

function recordTest(state, event, next, record, archiveDirectory) {
  const test = inspectTest(state, event, next.seq, archiveDirectory);
  if (test.outcome === 'passed') {
    next.phase = 'done';
    next.summary = '当前版本已通过已确认计划的逐项验收。';
  } else if (test.outcome === 'failed') {
    next.phase = 'develop';
    next.summary = `修复已实测失败的检查点：${test.report.failedChecks.join('、')}。保留报告中的其余待验项。`;
  } else {
    next.summary = test.reason || '验收材料尚未满足门禁，请按报告补充实测。';
  }
  next.lastTest = test;
  record.test = test;
}

function recordQuestion(state, event, next, record) {
  if (event.replan !== undefined && typeof event.replan !== 'boolean') {
    throw protocolError('replan 必须是布尔值');
  }
  if (event.replan) requirePhase(state, 'develop', 'verify');
  const question = {
    decisionId: `${next.stepId}:decision`, question: requiredText(event.question, 'question'),
    resumePhase: state.phase, resumeStepId: state.stepId, replan: event.replan === true,
  };
  next.phase = 'waiting';
  next.question = question;
  next.summary = question.question;
  record.question = question;
}

function recordAnswer(state, event, next, record) {
  const question = state.question;
  if (event.decisionId !== question.decisionId) throw protocolError('decisionId 与当前待决问题不符');
  const answer = requiredText(event.answer, 'answer');
  if (question.replan && !['approve-replan', 'keep-plan'].includes(event.choice)) {
    throw protocolError('计划变更须明确选择 approve-replan 或 keep-plan');
  }
  if (!question.replan && event.choice !== undefined) throw protocolError('普通答复仅需填写 answer');
  const decision = { ...question, seq: next.seq, answer, choice: event.choice ?? null };
  next.phase = decision.choice === 'approve-replan' ? 'plan' : question.resumePhase;
  next.summary = answer;
  next.question = null;
  next.lastDecision = decision;
  record.decision = decision;
}

function capturePlan(state, event, archiveDirectory) {
  const extending = event.type === 'extend';
  const path = extending ? event.planFile ?? state.plan.planFile : event.planFile;
  const planFile = resolve(state.project, requiredText(path, 'planFile'));
  const privateRoot = privateRootFor(state, archiveDirectory);
  const planTarget = projectFile(state.project, planFile, 'planFile', privateRoot);
  const plan = readJson(planTarget, 'plan');
  const planId = planIdFor(plan);
  const fileRevisionSource = sourceFrom(state.project, plan);
  const eventSource = sourceFrom(state.project, event);
  const revisionSource = eventSource || fileRevisionSource || (extending && state.plan.revisionSource);
  if (!revisionSource) throw protocolError('计划须绑定独立的 revisionFile 或 revisionInputs');
  if (eventSource && fileRevisionSource && JSON.stringify(eventSource) !== JSON.stringify(fileRevisionSource)) {
    throw protocolError('事件和计划文件的版本来源不一致');
  }
  if (extending) {
    const originalIds = new Set(state.plan.snapshot.checks.map(check => check.id));
    const existing = plan.checks.filter(check => originalIds.has(check.id));
    if (plan.checks.length <= originalIds.size || existing.length !== originalIds.size ||
        planIdFor({ checks: existing }) !== state.plan.planId ||
        JSON.stringify(revisionSource) !== JSON.stringify(state.plan.revisionSource) ||
        (state.plan.fileRevisionSource && !fileRevisionSource)) {
      throw protocolError('extend 只允许保留原检查点和版本来源并增加回归项，其他变更须请求人工批准重排');
    }
  }
  checkPlannedSource(state.project, revisionSource, planTarget, privateRoot);
  const checks = plan.checks.map(({ id, expected, procedure, evidence }) =>
    procedure === undefined ? { id, expected, evidence } : { id, expected, procedure, evidence });
  return { planFile, planId, snapshot: { checks }, revisionSource, fileRevisionSource,
    privateRoot, manifestIdentity: manifestIdentity(planTarget) };
}

/**
 * 消费当前任务的事件，读取计划与实测，必要时归档失败附件，返回新 checkpoint。
 * 存储方用原 seq 作条件写入，驱动可附 stepId 拒绝已过时的响应。
 */
export function advance(state, event, { archiveDirectory } = {}) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw protocolError('需要事件对象');
  if (event.stepId !== undefined && event.stepId !== state.stepId) throw protocolError('stepId 已过期');
  if (event.type === 'answer') requirePhase(state, 'waiting');
  else requirePhase(state, 'plan', 'develop', 'verify');
  const seq = state.seq + 1;
  const next = { ...state, seq, stepId: stepId(state.id, seq) };
  const record = { seq, stepId: next.stepId, type: event.type, from: state.phase };
  switch (event.type) {
    case 'planned':
    case 'extend': {
      if (event.type === 'extend') requirePhase(state, 'develop', 'verify');
      else requirePhase(state, 'plan');
      next.summary = requiredText(event.summary, 'summary');
      next.plan = capturePlan(state, event, archiveDirectory);
      if (event.type === 'planned') next.phase = 'develop';
      record.plan = next.plan;
      break;
    }
    case 'developed':
      requirePhase(state, 'develop');
      next.summary = requiredText(event.summary, 'summary');
      next.phase = 'verify';
      break;
    case 'tested':
      requirePhase(state, 'verify');
      recordTest(state, event, next, record, archiveDirectory);
      break;
    case 'checkpoint':
      next.summary = requiredText(event.summary, 'summary');
      break;
    case 'ask':
      recordQuestion(state, event, next, record);
      break;
    case 'answer':
      recordAnswer(state, event, next, record);
      break;
    default:
      throw protocolError(`未知事件：${event.type}`);
  }
  next.history = [...state.history, { ...record, to: next.phase, summary: next.summary }];
  return next;
}
