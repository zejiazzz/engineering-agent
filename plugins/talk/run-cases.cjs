'use strict';

/** 账本的待验项目既可在新建时使用，也可在恢复全量运行时补齐。 */
function pendingCase() {
  return { status: 'pending', attempts: [] };
}

function hasCurrentEvidence(item, definition) {
  if (item.mode !== definition.mode) return false;
  if (definition.task) {
    const attempt = item.attempts.at(-1);
    if (attempt?.outcome !== 'succeeded' || attempt.stale) return false;
  }
  return definition.evidence.every(key => {
    const value = item.evidence?.[key];
    return typeof value === 'string' && Boolean(value.trim());
  });
}

/** 恢复时按当前矩阵检查缺项和证据字段，保留任务身份和历史记录。 */
function restoreCases(run, definitions) {
  for (const definition of definitions) {
    const { id } = definition;
    if (!Object.hasOwn(run.cases, id)) {
      if (run.coverage !== 'full') continue;
      run.cases[id] = pendingCase();
    }
    const item = run.cases[id];
    if (!item) continue;
    if (!item.history) {
      const legacyAction = { passed: 'pass', failed: 'fail', blocked: 'block' }[
        item.status
      ];
      recordCaseEvent(item, legacyAction);
    }
    if (item.status === 'passed' && !hasCurrentEvidence(item, definition)) {
      item.status = 'pending';
    }
  }
  return run;
}

/** 保存当前投影中的证据、诊断和重开依据，归到对应尝试。 */
function recordCaseEvent(item, action) {
  let detail;
  if (action === 'pass') detail = { mode: item.mode, evidence: item.evidence };
  if (action === 'fail' || action === 'block')
    detail = { finding: item.finding };
  if (action === 'reopen') detail = { reason: item.reopenReason };
  if (!detail) return;
  item.history ??= [];
  item.history.push({
    action,
    attempt: item.attempts.length || undefined,
    at: new Date().toISOString(),
    ...detail,
  });
}

/** 已移除场景随账本保留，定向运行的目标失效时阻止发布通过结果。 */
function buildCaseReport(run, definitions, current) {
  const items = Object.entries(run.cases).map(([id, item]) => {
    if (!definitions.has(id))
      return { id, next: 'retired', retired: true, ...item };
    const attempt = item.attempts.at(-1);
    const observing = attempt && attempt.phase !== 'terminal';
    const next = observing
      ? 'observe'
      : {
          pending: 'verify',
          failed: 'diagnose',
          blocked: 'unblock',
          passed: 'done',
        }[item.status];
    return { id, next, ...item };
  });
  const active = items.filter(item => !item.retired);
  const scopeCurrent =
    run.coverage === 'full' || active.length === items.length;
  const passed =
    current &&
    scopeCurrent &&
    active.length > 0 &&
    active.every(item => item.status === 'passed');
  return {
    id: run.id,
    coverage: run.coverage,
    scopeCurrent,
    current,
    passed,
    items,
  };
}

module.exports = {
  pendingCase,
  restoreCases,
  recordCaseEvent,
  buildCaseReport,
};
