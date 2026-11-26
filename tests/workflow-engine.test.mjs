import assert from 'node:assert/strict';
import { linkSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { advance, createTask, currentRevision, view } from '../workflow-engine.mjs';
import { planIdFor } from '../verify.mjs';
import { storeFor } from '../workflow-store.mjs';

function fixture(t) {
  const project = mkdtempSync(join(tmpdir(), 'workflow-engine-'));
  const archiveDirectory = mkdtempSync(join(tmpdir(), 'workflow-evidence-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  t.after(() => rmSync(archiveDirectory, { recursive: true, force: true }));
  const json = (name, body) => writeFileSync(join(project, name), JSON.stringify(body));
  const initial = createTask({ id: 'order', objective: '保存并重新打开标题', project });
  const plan = { checks: [
    { id: 'save', expected: '保存成功', evidence: ['log'] },
    { id: 'read', expected: '重新打开显示新标题', evidence: ['log'] },
  ] };
  const planned = { type: 'planned', planFile: 'plan.json', revisionFile: 'build-id.txt', summary: '确认保存和回读范围' };
  const developed = { type: 'developed', summary: '修改保存并自验回读' };
  const tested = { type: 'tested', revision: 'build-2', resultsFile: 'results.json' };
  const results = {
    revision: tested.revision, planId: planIdFor(plan), checks: plan.checks.map(check => ({
      id: check.id, status: 'passed', actual: check.expected, evidence: { log: 'run.log' },
    })),
  };
  json('plan.json', plan);
  writeFileSync(join(project, 'build-id.txt'), tested.revision);
  writeFileSync(join(project, 'run.log'), '实际观察记录');
  const implementing = advance(initial, planned, { archiveDirectory });
  const verifying = advance(implementing, developed);
  const run = (input, state = verifying) => {
    json('results.json', input);
    return advance(state, tested, { archiveDirectory });
  };
  return { initial, implementing, verifying, plan, planned, developed, tested, results, project, json, run, archiveDirectory };
}

test('已确认范围与真实报告决定完成，任务可从 JSON 检查点继续', t => {
  const f = fixture(t);
  assert.equal(f.initial.phase, 'plan');
  assert.equal(f.initial.seq, 0);
  const checkpoint = advance(f.verifying, { type: 'checkpoint', summary: '保存步骤已测，继续回读' });
  const restored = JSON.parse(JSON.stringify(view(checkpoint)));
  assert.equal(restored.summary, '保存步骤已测，继续回读');
  assert.equal(restored.phase, 'verify');
  const done = f.run(f.results, restored);
  assert.equal(done.phase, 'done');
  assert.equal(done.lastTest.report.exitCode, 0);
  assert.deepEqual(done.history.map(row => row.to), ['develop', 'verify', 'verify', 'done']);
  assert.throws(() => advance(done, f.tested));
  view(done).plan.snapshot.checks.length = 0;
  assert.equal(done.plan.snapshot.checks.length, 2);
});

test('锁定计划和留存实测时仅复制门禁契约，保留宿主绑定', t => {
  const f = fixture(t);
  f.json('plan.json', { debug: '私有元信息', checks: f.plan.checks.map(check => ({
    ...check, extra: '私有元信息',
  })) });
  const developed = advance({ ...f.initial, executor: 'host-binding' }, f.planned);
  assert.deepEqual(developed.plan.snapshot, f.plan);
  const verifying = advance(developed, f.developed);
  const done = f.run({
    ...f.results, debug: '私有元信息',
    checks: f.results.checks.map(row => ({ ...row, fixture: '私有元信息' })),
  }, verifying);
  assert.equal(done.executor, 'host-binding');
  assert.equal(done.phase, 'done');
  assert.doesNotMatch(JSON.stringify(done), /私有元信息/);
});

test('只把已实测的失败交还开发，保留旧版本问题与后续修复记录', t => {
  const f = fixture(t);
  const [save, read] = f.results.checks;
  const failed = { ...read, status: 'failed', actual: '重开仍显示旧标题' };
  const repair = f.run({ ...f.results, checks: [failed] });
  assert.equal(repair.phase, 'develop');
  assert.deepEqual(repair.lastTest.report.failedChecks, ['read']);
  assert.ok(repair.lastTest.report.issues.some(issue => issue.id === save.id));
  const retest = advance(repair, f.developed);
  writeFileSync(join(f.project, 'build-id.txt'), 'build-3');
  writeFileSync(join(f.project, 'run.log'), '覆盖同名附件');
  f.json('results.json', { ...f.results, revision: 'build-3' });
  const done = advance(retest, { ...f.tested, revision: 'build-3' });
  assert.equal(done.phase, 'done');
  assert.equal(done.history.find(row => row.test)?.test.results.checks[0].actual, failed.actual);
  const [archived] = done.history.find(row => row.test).test.archivedEvidence;
  assert.match(archived.sha256, /^[a-f0-9]{64}$/);
  assert.equal(readFileSync(archived.path, 'utf8'), '实际观察记录');
  if (process.platform !== 'win32') assert.equal(statSync(archived.path).mode & 0o777, 0o400);
  writeFileSync(join(f.project, 'build-id.txt'), f.tested.revision);
  for (const checks of [
    [save, { ...failed, actual: ' ' }], [save, { ...failed, evidence: {} }],
    [save, { ...failed, evidence: { log: 'results.json' } }], [save, failed, failed],
    [save, { ...failed, status: 'blocked' }], [save, { ...failed, status: 'waived' }],
    [save, { ...failed, status: 'pending' }], [save], [failed, null],
  ]) {
    const state = f.run({ ...f.results, checks });
    assert.equal(state.phase, 'verify', JSON.stringify(checks));
    assert.deepEqual(state.lastTest.report.failedChecks, []);
  }
  for (const field of ['revision', 'planId']) {
    const stale = f.run({ ...f.results, checks: [save, failed], [field]: 'previous' });
    assert.equal(stale.phase, 'verify');
    assert.deepEqual(stale.lastTest.report.failedChecks, []);
  }
});

test('计划变化后恢复基线，或由当前人工决定批准重排，保留前计划和答复', t => {
  const f = fixture(t);
  const revised = { checks: [f.plan.checks[0]] };
  f.json('plan.json', revised);
  const changed = f.run({ ...f.results, planId: planIdFor(revised), checks: [f.results.checks[0]] });
  assert.equal(changed.phase, 'verify');
  assert.equal(changed.lastTest.outcome, 'plan-changed');
  assert.equal(changed.plan.snapshot.checks.length, 2);
  assert.throws(() => advance(changed, f.planned));
  const waiting = advance(changed, { type: 'ask', replan: true, question: '范围变化，能否按新范围重排？' });
  const response = { type: 'answer', decisionId: waiting.question.decisionId, answer: '确认本次变更' };
  assert.throws(() => advance(waiting, response));
  const retained = advance(waiting, { ...response, choice: 'keep-plan' });
  assert.equal(retained.phase, 'verify');
  assert.deepEqual(retained.plan, f.implementing.plan);
  const approved = advance(waiting, { ...response, choice: 'approve-replan' });
  assert.equal(approved.phase, 'plan');
  const renewed = advance(approved, f.planned);
  assert.equal(renewed.plan.planId, planIdFor(revised));
  assert.equal(renewed.history[0].plan.snapshot.checks.length, 2);
  assert.equal(renewed.lastDecision.answer, response.answer);
});

test('待答复仅接受当前决策，旧回调与越阶段事件保持原检查点', t => {
  const f = fixture(t);
  const waiting = advance(f.implementing, { type: 'ask', stepId: f.implementing.stepId, question: '确认入口？' });
  const frozen = view(waiting);
  assert.throws(() => advance(waiting, { type: 'checkpoint', summary: '继续' }));
  assert.throws(() => advance(waiting, { type: 'answer', decisionId: 'old', answer: '确认' }));
  assert.deepEqual(waiting, frozen);
  const decision = { type: 'answer', decisionId: waiting.question.decisionId, answer: '从列表进入' };
  const resumed = advance(waiting, decision);
  assert.equal(resumed.phase, 'develop');
  assert.equal(resumed.lastDecision.resumeStepId, f.implementing.stepId);
  assert.equal(resumed.lastDecision.answer, '从列表进入');
  assert.throws(() => advance(resumed, decision));
  assert.throws(() => advance(resumed, { ...f.developed, stepId: f.implementing.stepId }));
  assert.throws(() => advance(f.initial, f.developed));
});

test('拒绝项目外清单和链接逃逸，损坏、缺失的验收文件可原阶段补交', t => {
  const f = fixture(t);
  const outside = fixture(t);
  const external = join(outside.project, 'plan.json');
  symlinkSync(external, join(f.project, 'link.json'));
  for (const planFile of [external, 'link.json']) {
    assert.throws(() => advance(f.initial, { ...f.planned, planFile }));
    const wrong = advance(f.verifying, { ...f.tested, resultsFile: planFile });
    assert.equal(wrong.phase, 'verify');
    assert.equal(f.run(f.results, wrong).phase, 'done');
  }
  assert.equal(advance(f.verifying, { ...f.tested, resultsFile: 'absent.json' }).lastTest.outcome, 'incomplete');
  writeFileSync(join(f.project, f.tested.resultsFile), '{');
  assert.equal(advance(f.verifying, f.tested).lastTest.report, null);
  assert.equal(f.run(f.results).phase, 'done');
});

test('旧结果与事件不能自报旧版本，升级前的检查点可经人工重排恢复', t => {
  const f = fixture(t);
  writeFileSync(join(f.project, 'build-id.txt'), 'build-3');
  const stale = f.run(f.results);
  assert.equal(stale.phase, 'verify');
  assert.equal(stale.lastTest.currentRevision, 'build-3');
  assert.match(stale.lastTest.reason, /当前版本/);
  const legacy = { ...f.verifying, plan: { ...f.verifying.plan, revisionSource: undefined } };
  assert.throws(() => currentRevision(legacy), /重排/);
  assert.equal(f.run(f.results, legacy).phase, 'verify');
  const wait = advance(legacy, { type: 'ask', replan: true, question: '补充构建来源？' });
  const replan = advance(wait, { type: 'answer', decisionId: wait.question.decisionId, answer: '批准', choice: 'approve-replan' });
  assert.equal(currentRevision(advance(replan, f.planned)), 'build-3');
});

test('工作区版本取自真实输入，包括开发后新建的文件，拒绝清单自证与硬链接', t => {
  const f = fixture(t);
  const { revisionFile, ...planned } = f.planned;
  assert.throws(() => advance(f.initial, planned), /revisionFile/);
  linkSync(join(f.project, 'plan.json'), join(f.project, 'plan-link'));
  assert.throws(() => advance(f.initial, { ...planned, revisionFile: 'plan-link' }));
  const implementing = advance(f.initial, { ...planned, revisionInputs: ['app.js', 'config.json'] });
  assert.throws(() => currentRevision(implementing));
  writeFileSync(join(f.project, 'app.js'), 'v1');
  f.json('config.json', {});
  const first = currentRevision(implementing);
  assert.match(first, /^[a-f0-9]{64}$/);
  const verifying = advance(implementing, f.developed);
  writeFileSync(join(f.project, 'app.js'), 'v2');
  const second = currentRevision(verifying);
  assert.notEqual(second, first);
  f.json('results.json', { ...f.results, revision: first });
  assert.equal(advance(verifying, { ...f.tested, revision: first }).phase, 'verify');
  f.json('results.json', { ...f.results, revision: second });
  assert.equal(advance(verifying, { ...f.tested, revision: second }).phase, 'done');
  rmSync(join(f.project, 'app.js'));
  linkSync(join(f.project, 'results.json'), join(f.project, 'app.js'));
  assert.match(advance(verifying, { ...f.tested, revision: second }).lastTest.reason, /独立|清单/);
});

test('纯增加回归可直接扩展，旧结果不可复用，删项、改预期或换版本来源需人工批准', t => {
  const f = fixture(t);
  const extra = { id: 'retry', expected: '可重新保存', evidence: ['log'] };
  const extend = { type: 'extend', summary: '保存入口新增重试回归' };
  f.json('plan.json', { checks: [...f.plan.checks, extra] });
  const expanded = advance(f.verifying, extend);
  assert.equal(expanded.phase, 'verify');
  assert.equal(expanded.plan.snapshot.checks.length, 3);
  assert.notEqual(expanded.plan.planId, f.verifying.plan.planId);
  assert.equal(f.run(f.results, expanded).phase, 'verify');
  for (const checks of [[extra], [extra, { ...f.plan.checks[0], expected: '更宽松' }, f.plan.checks[1]]]) {
    f.json('plan.json', { checks });
    assert.throws(() => advance(f.verifying, extend), /重排/);
  }
  f.json('plan.json', { revisionFile: 'other.id', checks: [...f.plan.checks, extra] });
  assert.throws(() => advance(f.implementing, extend), /重排/);
});

test('项目内私有任务目录可归档失败，状态与归档不允许作为实测材料', t => {
  const f = fixture(t);
  const archiveDirectory = mkdtempSync(join(f.project, 'private-state-'));
  const planned = advance(f.initial, f.planned, { archiveDirectory });
  const verifying = advance(planned, f.developed);
  const failed = { ...f.results.checks[0], status: 'failed' };
  f.json('results.json', { ...f.results, checks: [failed, f.results.checks[1]] });
  const unavailable = advance(verifying, f.tested);
  assert.equal(unavailable.phase, 'verify');
  assert.equal(unavailable.lastTest.archivedEvidence, undefined);
  const repair = advance(verifying, f.tested, { archiveDirectory });
  assert.equal(repair.phase, 'develop');
  const [retained] = repair.lastTest.archivedEvidence;
  symlinkSync(retained.path, join(f.project, 'archive-link'));
  linkSync(retained.path, join(f.project, 'archive-hardlink'));
  for (const log of ['archive-link', 'archive-hardlink']) {
    const forged = { ...failed, status: 'passed', evidence: { log } };
    f.json('results.json', { ...f.results, checks: [forged, f.results.checks[1]] });
    assert.equal(advance(advance(repair, f.developed), f.tested, { archiveDirectory }).phase, 'verify');
  }
  writeFileSync(join(archiveDirectory, 'receipt.json'), JSON.stringify(f.results));
  linkSync(join(archiveDirectory, 'receipt.json'), join(f.project, 'receipt-hardlink'));
  for (const resultsFile of [join(archiveDirectory, 'receipt.json'), 'receipt-hardlink']) {
    assert.equal(advance(verifying, { ...f.tested, resultsFile }, { archiveDirectory }).phase, 'verify');
  }
});

function checkSiblingIsolation(t, useDefault) {
  const f = fixture(t);
  const root = join(f.project, useDefault ? '.agent-harness-state' : 'explicit-private-state');
  const previous = process.env.AGENT_HARNESS_STATE_DIR;
  let current;
  let sibling;
  try {
    if (useDefault) delete process.env.AGENT_HARNESS_STATE_DIR;
    else process.env.AGENT_HARNESS_STATE_DIR = root;
    current = storeFor(f.project, f.initial.id);
    sibling = storeFor(f.project, 'sibling');
    if (useDefault) assert.equal(current.directory, join(realpathSync(f.project), '.agent-harness-state',
      'tasks', 'task-' + Buffer.from(f.initial.id).toString('hex')));
    current.create(f.initial);
    sibling.create(createTask({ id: 'sibling', objective: '其他任务', project: f.project }));
  } finally {
    if (previous === undefined) delete process.env.AGENT_HARNESS_STATE_DIR;
    else process.env.AGENT_HARNESS_STATE_DIR = previous;
  }
  const options = { archiveDirectory: current.directory };
  const planned = advance(f.initial, f.planned, options);
  assert.equal(planned.plan.privateRoot, realpathSync(root));
  const verifying = advance(planned, f.developed, options);
  const foreign = join(sibling.directory, 'evidence.log');
  writeFileSync(foreign, '另一个任务的状态记录');
  linkSync(foreign, join(f.project, 'foreign.log'));
  assert.throws(() => advance(f.initial, { ...f.planned, revisionFile: 'foreign.log' }, options), /状态目录/);
  writeFileSync(join(sibling.directory, 'plan.json'), JSON.stringify(f.plan));
  assert.throws(() => advance(f.initial, { ...f.planned, planFile: join(sibling.directory, 'plan.json') }, options),
    /状态目录/);
  f.json('results.json', { ...f.results, checks: f.results.checks.map(row => ({
    ...row, evidence: { log: 'foreign.log' },
  })) });
  const evidence = advance(verifying, f.tested, options);
  assert.equal(evidence.phase, 'verify');
  assert.ok(evidence.lastTest.report.issues.some(issue => /状态目录/.test(issue.reason)));
  writeFileSync(join(sibling.directory, 'results.json'), JSON.stringify(f.results));
  assert.match(advance(verifying, { ...f.tested, resultsFile: join(sibling.directory, 'results.json') },
    options).lastTest.reason, /状态目录/);
}

test('默认 tasks 目录隔离兄弟任务的计划、版本来源、附件及结果', t => checkSiblingIsolation(t, true));
test('显式状态根隔离兄弟任务的计划、版本来源、附件及结果', t => checkSiblingIsolation(t, false));
