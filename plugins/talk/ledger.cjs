'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const {
  pendingCase,
  restoreCases,
  recordCaseEvent,
  buildCaseReport,
} = require('./run-cases.cjs');

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

/** 配置错误会影响全量通过判定，先拒绝含歧义或缺少证据要求的用例矩阵。 */
function indexDefinitions(definitions) {
  requireCondition(
    Array.isArray(definitions) && definitions.length > 0,
    'definitions 必须包含至少一个用例'
  );
  const cases = new Map();
  for (const [index, definition] of definitions.entries()) {
    const { id, mode, task, evidence } = definition ?? {};
    requireCondition(
      typeof id === 'string' &&
        /^[a-z0-9][a-z0-9-]*$/.test(id) &&
        id !== 'full',
      `definitions[${index}] 的用例 ID 格式无效`
    );
    requireCondition(!cases.has(id), `用例 ID 重复 ${id}`);
    requireCondition(
      typeof mode === 'string' &&
        mode.trim() &&
        (task === undefined || typeof task === 'boolean'),
      `用例 ${id} 的 mode 或 task 无效`
    );
    requireCondition(
      Array.isArray(evidence) &&
        evidence.length > 0 &&
        evidence.every(key => typeof key === 'string' && key.trim()) &&
        new Set(evidence).size === evidence.length,
      `用例 ${id} 必须指定非空且互不重复的证据字段`
    );
    cases.set(id, definition);
  }
  return cases;
}

// 项目注入用例矩阵、代码指纹和本地存储，CLI 事件与账本结构跨项目复用。
function runTalkLedger(args, options) {
  try {
    execute(args, options);
  } catch (error) {
    console.error(
      error.code === 'EEXIST'
        ? '账本正在写入，请稍后读取；如进程已退出，核对锁文件中的 PID。'
        : error.message
    );
    process.exitCode = 2;
  }
}

function execute(
  args,
  {
    stateDir,
    currentCode,
    definitions,
    failureSources = ['product', 'service', 'environment', 'unknown'],
    isValidQuote = value => Number.isFinite(value) && value >= 0,
    quoteError = 'quote 必须为已观察到的非负数，免费传 0',
  }
) {
  const cases = indexDefinitions(definitions);

  function text(value, field) {
    requireCondition(
      typeof value === 'string' && value.trim() && value.length <= 2000,
      `请提供 ${field} 的简短证据`
    );
    return value.trim();
  }

  function assertCurrent(run) {
    requireCondition(
      run.code === fingerprint(),
      '代码已变化，请先核对影响范围并执行 revise'
    );
  }

  function fingerprint() {
    const value = currentCode();
    requireCondition(
      typeof value === 'string' && value.trim(),
      '代码指纹不能为空'
    );
    return value;
  }

  const output = value => console.log(JSON.stringify(value, null, 2));

  function getRunPath(runId) {
    requireCondition(
      /^[a-z0-9][a-z0-9-]{0,63}$/.test(runId),
      '运行编号仅支持小写英文、数字和短横线'
    );
    return path.join(stateDir, `${runId}.json`);
  }

  function load(file) {
    requireCondition(fs.existsSync(file), '运行不存在，请先执行 init');
    return restoreCases(JSON.parse(fs.readFileSync(file, 'utf8')), definitions);
  }

  /** 单写入单元，更新崩溃时保留上一份完整文件。 */
  function change(file, update) {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const lock = `${file}.lock`;
    const handle = fs.openSync(lock, 'wx', 0o600);
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(handle, String(process.pid));
      const run = update();
      fs.writeFileSync(temp, `${JSON.stringify(run, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
      fs.renameSync(temp, file);
      return run;
    } finally {
      fs.closeSync(handle);
      fs.rmSync(temp, { force: true });
      fs.unlinkSync(lock);
    }
  }

  const last = item => item.attempts.at(-1);

  function isOpen(attempt) {
    return Boolean(attempt && attempt.phase !== 'terminal');
  }

  function start(runId, selection) {
    const ids = selection === 'full' ? [...cases.keys()] : selection.split(',');
    requireCondition(
      ids.length === new Set(ids).size && ids.every(id => cases.has(id)),
      '用例编号未知或重复，请先运行 list'
    );
    return {
      id: runId,
      coverage: selection === 'full' ? 'full' : 'selected',
      code: fingerprint(),
      cases: Object.fromEntries(ids.map(id => [id, pendingCase()])),
      revisionHistory: [],
    };
  }

  function begin(run, item, definition, detail) {
    assertCurrent(run);
    const previous = last(item);
    requireCondition(
      definition.task &&
        item.status === 'pending' &&
        (!previous || (previous.phase === 'terminal' && previous.stale)),
      '请先完成原提交对账及验收，重复发起需要明确复验依据'
    );
    const marker = text(detail.marker, 'marker');
    const duplicate = Object.values(run.cases).some(row =>
      row.attempts.some(attempt => attempt.marker === marker)
    );
    requireCondition(!duplicate, '提交标记已使用');
    requireCondition(isValidQuote(detail.quote), quoteError);
    item.attempts.push({
      phase: 'submitting',
      marker,
      quote: detail.quote,
      at: new Date().toISOString(),
    });
  }

  function reconcile(run, item, action, detail) {
    const attempt = last(item);
    requireCondition(isOpen(attempt), '当前没有可对账的提交');
    const evidence = text(detail.evidence, 'evidence');
    if (action === 'accepted') {
      requireCondition(
        attempt.phase === 'submitting',
        '该提交已登记会话和任务'
      );
      const chat = text(detail.chat, 'chat');
      const task = text(detail.task, 'task');
      const duplicate = Object.values(run.cases).some(row =>
        row.attempts.some(
          known =>
            known !== attempt && known.chat === chat && known.task === task
        )
      );
      requireCondition(!duplicate, '该会话任务已在本次运行登记');
      attempt.chat = chat;
      attempt.task = task;
      attempt.phase = 'accepted';
    } else {
      const allowed =
        attempt.phase === 'accepted'
          ? ['succeeded', 'failed', 'canceled']
          : ['not-accepted'];
      requireCondition(
        allowed.includes(detail.outcome),
        '终态与当前提交身份不一致'
      );
      attempt.phase = 'terminal';
      attempt.outcome = detail.outcome;
    }
    attempt[action] = evidence;
    if (item.status === 'failed') return;
    const taskFailed = action === 'terminal' && detail.outcome !== 'succeeded';
    item.status = taskFailed ? 'failed' : 'pending';
    if (taskFailed) item.finding = { source: 'unknown', evidence };
    else delete item.finding;
  }

  function pass(run, item, definition, detail) {
    assertCurrent(run);
    requireCondition(item.status === 'pending', '请先关闭失败或阻塞再登记通过');
    requireCondition(
      detail.mode === definition.mode,
      `该用例需要 ${definition.mode} 证据`
    );
    if (definition.task) {
      requireCondition(
        last(item)?.outcome === 'succeeded' && !last(item).stale,
        '需要当前受影响代码下同一真实任务的成功终态'
      );
    }
    item.evidence = Object.fromEntries(
      definition.evidence.map(key => [key, text(detail.evidence?.[key], key)])
    );
    item.mode = detail.mode;
    item.status = 'passed';
  }

  function apply(run, id, action, detail) {
    const definition = cases.get(id);
    const item = Object.hasOwn(run.cases, id) ? run.cases[id] : undefined;
    const isReconciliation = action === 'accepted' || action === 'terminal';
    requireCondition(
      item && (definition || isReconciliation),
      '用例不属于当前运行或已移除'
    );
    if (action === 'begin') begin(run, item, definition, detail);
    else if (action === 'adopt') {
      requireCondition(!last(item), '已有账本记录，请续跑原任务');
      begin(run, item, definition, detail);
      reconcile(run, item, 'accepted', detail);
      last(item).adopted = true;
    } else if (isReconciliation) reconcile(run, item, action, detail);
    else if (action === 'pass') pass(run, item, definition, detail);
    else if (action === 'fail' || action === 'block') {
      requireCondition(
        failureSources.includes(detail.source),
        '请提供有效的 source'
      );
      item.finding = {
        source: detail.source,
        evidence: text(detail.evidence, 'evidence'),
      };
      item.status = action === 'fail' ? 'failed' : 'blocked';
      delete item.evidence;
    } else if (action === 'reopen') {
      requireCondition(
        ['failed', 'blocked'].includes(item.status) && !isOpen(last(item)),
        '已有提交须先对账，才能重新执行'
      );
      item.reopenReason = text(detail.evidence, '改变的条件或新的证据');
      const attempt = last(item);
      // 成功任务只缺证据时补查原任务，已证实失败才需要新的尝试。
      if (
        attempt &&
        (item.status === 'failed' || attempt.outcome !== 'succeeded')
      )
        attempt.stale = true;
      item.status = 'pending';
      delete item.finding;
    } else throw new Error(`未知事件 ${action}`);
    recordCaseEvent(item, action);
  }

  function revise(run, detail) {
    const impacted = detail.affected;
    requireCondition(
      Array.isArray(impacted) &&
        impacted.every(id => Object.hasOwn(run.cases, id)),
      'affected 需列出当前运行中受改动影响的用例'
    );
    const reason = text(detail.evidence, '变更和受影响范围依据');
    const newCode = fingerprint();
    requireCondition(run.code !== newCode, '未检测到代码变化');
    run.revisionHistory.push({ code: run.code, affected: impacted, reason });
    run.code = newCode;
    for (const id of new Set(impacted)) {
      const item = run.cases[id];
      if (last(item)) last(item).stale = true;
      item.status = 'pending';
      delete item.evidence;
      delete item.finding;
    }
  }

  function report(run) {
    return buildCaseReport(run, cases, run.code === fingerprint());
  }

  function main([command, runId = '', arg, action, detail]) {
    if (command === 'list') return output(definitions);
    const file = getRunPath(runId);
    if (command === 'report') {
      const result = report(load(file));
      output(result);
      if (!result.passed) process.exitCode = 1;
      return;
    }
    const run = change(file, () => {
      if (command === 'init') {
        requireCondition(!fs.existsSync(file), '运行已存在，请继续该运行');
        return start(runId, arg ?? 'full');
      }
      const run = load(file);
      if (command === 'revise') revise(run, JSON.parse(arg));
      else if (command === 'event') apply(run, arg, action, JSON.parse(detail));
      else throw new Error('支持的命令为 list、init、event、revise、report');
      return run;
    });
    output(command === 'event' ? run.cases[arg] : report(run));
  }

  main(args);
}

module.exports = { runTalkLedger };
