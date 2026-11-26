import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { advance, view } from './workflow-engine.mjs';
import { withDriver } from './workflow-store.mjs';

const hasText = value => typeof value === 'string' && value.trim().length > 0;
const terminal = state => state.phase === 'done' || state.phase === 'waiting';
const actionFile = 'host-action.json';
const hostEvents = new Set(['planned', 'extend', 'developed', 'tested', 'checkpoint', 'ask']);
const invalidReply = message => Object.assign(new Error(message), { code: 'EDRIVERPROTOCOL' });

// 日志与状态分别原子替换。先持久化意图再调宿主，先持久化计算完的回执再提交任务。
function writeJournal(store, journal) {
  const temporary = join(store.directory, `.host-action-${randomUUID()}.tmp`);
  const file = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(file, JSON.stringify(journal));
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, join(store.directory, actionFile));
    if (process.platform !== 'win32') {
      const directory = openSync(store.directory, 'r');
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function readJournal(store) {
  let source;
  try { source = readFileSync(join(store.directory, actionFile), 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { version: 1, intent: null, remedies: [], probe: null, stall: null, receipt: null };
  }
  const journal = JSON.parse(source);
  if (journal?.version !== 1 || !Object.hasOwn(journal, 'intent') ||
      !Object.hasOwn(journal, 'receipt') || !Array.isArray(journal.remedies)) {
    throw new Error('宿主动作日志格式无效，请从本任务备份核对恢复');
  }
  return journal;
}

function settle(store, journal, state) {
  const receipt = journal.receipt;
  if (!receipt) return state;
  if (state.seq === receipt.seq && state.stepId === receipt.stepId) {
    store.commit(state.seq, receipt.next);
    state = receipt.next;
  } else if (!isDeepStrictEqual(state, receipt.next)) {
    throw new Error('宿主回执与当前检查点冲突，请核对任务记录');
  }
  journal.receipt = null;
  writeJournal(store, journal);
  return state;
}

function commit(store, journal, state, next) {
  journal.receipt = { seq: state.seq, stepId: state.stepId, next };
  writeJournal(store, journal);
  return settle(store, journal, state);
}

function current(store) {
  const journal = readJournal(store);
  return { journal, state: settle(store, journal, store.read()) };
}

function issueFor(row) {
  if (row?.type === 'checkpoint') return [row.from, 'checkpoint', row.summary.trim()];
  const test = row?.test;
  if (!test || test.outcome === 'passed') return null;
  const issues = test.report?.issues.map(({ id, key, reason }) =>
    [id ?? '', key ?? '', reason].join(' ')).sort();
  return [test.planId, test.outcome, issues?.join('\n') || test.reason || row.summary];
}

// 忽略仅版本号、轮次等变化；人工给出新约束或批准新计划后重新判断。
function repeatedProblem(state) {
  const index = state.history.length - 1;
  const problem = issueFor(state.history[index]);
  if (!problem) return null;
  const key = JSON.stringify(problem);
  for (let i = index - 1; i >= 0; i--) {
    const row = state.history[i];
    if (row.type === 'answer' || row.type === 'planned' || row.type === 'extend') break;
    if (JSON.stringify(issueFor(row)) === key) {
      return { problem: problem.at(-1), key };
    }
  }
  return null;
}

function checkAnchor(state, intent) {
  if (state.seq !== intent.seq || state.stepId !== intent.anchor) {
    throw new Error('宿主动作所绑定的任务检查点已改变，请先核对原动作');
  }
}

function beginLocked(store) {
  const { journal, state } = current(store);
  if (journal.stall) {
    const { problem } = journal.stall;
    journal.stall = null;
    writeJournal(store, journal);
    throw Object.assign(new Error(`宿主驱动重复返回同一结果，已保留原阶段。请核对诊断、策略或运行记录后恢复：${problem}`),
      { code: 'EDRIVERSTALLED' });
  }
  if (terminal(state)) {
    return { mode: state.phase, stepId: state.stepId, actionId: null, dispatchId: null, state: view(state) };
  }
  const existing = journal.intent;
  if (existing) checkAnchor(state, existing);
  const mode = existing && existing.status !== 'ready' ? 'reconcile' : 'execute';
  const intent = existing ?? {
    actionId: randomUUID(), stepId: state.stepId, seq: state.seq, anchor: state.stepId, originalState: state,
  };
  const dispatchId = randomUUID();
  journal.intent = { ...intent, mode, dispatchId, status: 'dispatched' };
  writeJournal(store, journal);
  const request = { mode, dispatchId, actionId: intent.actionId, stepId: intent.stepId, state: view(state) };
  if (intent.stepId !== state.stepId) request.originalState = view(intent.originalState);
  const recovery = journal.probe || repeatedProblem(state);
  if (recovery) {
    request.recovery = {
      problem: recovery.problem,
      previous: journal.remedies.filter(item => item.key === recovery.key)
        .map(({ diagnosis, strategy }) => ({ diagnosis, strategy })),
      instruction: '同一问题已重复。已实施修复先复验；仍失败时根据新观察更换策略，在事件附 recovery: {diagnosis, strategy}。真实取舍需要人工决定时返回 ask。',
    };
  }
  return request;
}

function recordRecovery(journal, state, next, event) {
  if (event.type === 'planned' || event.type === 'extend') journal.remedies = [];
  const recovery = journal.probe || repeatedProblem(state);
  journal.probe = null;
  if (terminal(next)) return;
  if (!recovery) return;
  const { diagnosis, strategy } = event.recovery ?? {};
  if (hasText(diagnosis) && hasText(strategy) &&
      !journal.remedies.some(item => item.key === recovery.key && item.strategy === strategy.trim())) {
    journal.remedies.push({ key: recovery.key, diagnosis: diagnosis.trim(), strategy: strategy.trim() });
    return;
  }
  if (JSON.stringify(issueFor(next.history.at(-1))) === recovery.key) {
    journal.stall = recovery;
  } else if (event.type === 'developed' || (event.type === 'checkpoint' && (journal.intent?.mode !== 'reconcile'))) {
    // 修复回执必须有机会实测。即使没有额外说明，也先执行复验，由新报告判断是否真的停滞。
    if (state.lastTest && state.lastTest.outcome !== 'passed') journal.probe = recovery;
  }
}

function finishLocked(store, { stepId, actionId, dispatchId, event }) {
  const { journal, state } = current(store);
  const intent = journal.intent;
  if (terminal(state) || !intent || intent.status !== 'dispatched' ||
      intent.actionId !== actionId || intent.stepId !== stepId || intent.dispatchId !== dispatchId) {
    throw new Error('actionId、stepId 或 dispatchId 与待完成的宿主动作不符');
  }
  checkAnchor(state, intent);
  if (event?.stepId !== undefined && event.stepId !== stepId) throw invalidReply('事件 stepId 已过期');
  if (event?.type === 'not_executed') {
    if (intent.mode !== 'reconcile' || !hasText(event.evidence)) {
      throw invalidReply('仅核对阶段可凭未执行且不会迟到执行的证据返回 not_executed');
    }
    journal.intent = { ...intent, status: 'ready', evidence: event.evidence.trim() };
    writeJournal(store, journal);
    return view(state);
  }
  // 已确认上次产物本身就是一个问题/检查点时，须与“仍无法核对”的同名事件区分。
  const reconciled = event?.type === 'reconciled';
  if (reconciled) {
    if (intent.mode !== 'reconcile' || !hasText(event.evidence)) {
      throw invalidReply('仅核对阶段可凭已完成的证据返回 reconciled');
    }
    event = event.event;
    if (event?.stepId !== undefined && event.stepId !== stepId) throw invalidReply('事件 stepId 已过期');
  }
  if (!hostEvents.has(event?.type)) throw invalidReply('宿主只能返回当前步骤的工作结果或人工问题');
  if (event.uncertainEffect !== undefined && (event.type !== 'ask' || typeof event.uncertainEffect !== 'boolean')) {
    throw invalidReply('uncertainEffect 仅用于 ask 的布尔标记');
  }
  const unresolved = event.uncertainEffect === true ||
    (!reconciled && intent.mode === 'reconcile' && ['ask', 'checkpoint'].includes(event.type));
  if (unresolved && event.replan) throw invalidReply('先核对原动作，再申请重排计划');
  const next = advance(state, { ...event, stepId: state.stepId }, { archiveDirectory: store.directory });
  journal.intent = unresolved ? { ...intent, status: 'unresolved', seq: next.seq, anchor: next.stepId } : null;
  recordRecovery(journal, state, next, event);
  return view(commit(store, journal, state, next));
}

/** 给会话内宿主领取一步。重复领取只准只读核对，直到确认旧执行已经结束或从未发生。 */
export function beginHostStep(store) {
  return withDriver(store, () => beginLocked(store));
}

/** 归还指定动作的回执，服务端根据计划与证据计算下一阶段。 */
export function finishHostStep(store, response) {
  return withDriver(store, () => finishLocked(store, response));
}

/** 人工答复绑定当前问题。仍待核对的宿主动作跨越人工答复保留其原 actionId。 */
export function applyManualEvent(store, event, expectedSeq) {
  return withDriver(store, () => {
    const { journal, state } = current(store);
    if (expectedSeq !== undefined && expectedSeq !== state.seq) throw new Error('expectedSeq 已过期');
    if (journal.intent && (state.phase !== 'waiting' || event?.type !== 'answer')) {
      throw new Error('宿主动作尚未结清，请先使用 begin 核对并回传原动作');
    }
    const next = advance(state, event, { archiveDirectory: store.directory });
    if (journal.intent) {
      checkAnchor(state, journal.intent);
      journal.intent = { ...journal.intent, seq: next.seq, anchor: next.stepId };
    }
    journal.stall = null;
    journal.probe = null;
    if (['answer', 'planned', 'extend'].includes(event.type)) journal.remedies = [];
    return view(commit(store, journal, state, next));
  });
}

const outputLimit = 1024 * 1024;

function invoke(command, request, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      shell: false, cwd: request.state.project, signal, stdio: ['pipe', 'pipe', 'inherit'],
    });
    const chunks = [];
    let bytes = 0;
    let started = false;
    child.once('spawn', () => { started = true; });
    child.once('error', error => {
      if (!started && ['EACCES', 'ENOENT', 'ENOEXEC'].includes(error.code)) error.neverStarted = true;
      reject(error);
    });
    child.stdin.on('error', () => {}); // 子进程退出时可能已关闭 stdin，以进程终态和回执为准。
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes <= outputLimit) chunks.push(chunk);
      else child.kill('SIGKILL');
    });
    child.once('close', (code, killedBy) => {
      if (bytes > outputLimit) return reject(new Error('宿主回执超过 1 MiB，请精简摘要和证据引用'));
      if (code !== 0) return reject(new Error(`宿主驱动退出：${killedBy || code}。下次运行将先核对原动作。`));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('宿主标准输出必须是一个 JSON 事件；下次运行将先核对原动作')); }
    });
    child.stdin.end(JSON.stringify(request) + '\n');
  });
}

/** 连续调度显式指定的可信驱动，直至验收完成或等待人工决策。命令及凭据不写入动作日志。 */
export function runWorkflow(store, command, { signal } = {}) {
  if (!Array.isArray(command) || !hasText(command[0]) ||
      !command.every(value => typeof value === 'string' && !value.includes('\0'))) {
    throw new Error('请显式提供可信宿主驱动的可执行文件及字符串参数');
  }
  return withDriver(store, async () => {
    let reconciledAfterError = null;
    for (;;) {
      if (signal?.aborted) throw new Error('宿主运行已取消，保留当前动作供恢复');
      const request = beginLocked(store);
      if (!request.actionId) return request.state;
      let received = false;
      try {
        const event = await invoke(command, request, signal);
        received = true;
        finishLocked(store, { ...request, event });
      } catch (error) {
        if (error.neverStarted && request.mode === 'execute') {
          const journal = readJournal(store);
          journal.intent.status = 'ready';
          writeJournal(store, journal);
        } else if ((!received || error.code === 'EDRIVERPROTOCOL') &&
            request.mode === 'execute' && !signal?.aborted && reconciledAfterError !== request.actionId) {
          // 已有进程可能完成了外部动作，当前运行先自行只读核对。相同动作反复失败时保留意图收口。
          reconciledAfterError = request.actionId;
          continue;
        }
        throw error;
      }
    }
  });
}
