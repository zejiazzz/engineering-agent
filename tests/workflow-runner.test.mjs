import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createTask } from '../workflow-engine.mjs';
import { storeFor } from '../workflow-store.mjs';
import { applyManualEvent, beginHostStep, finishHostStep, runWorkflow } from '../workflow-runner.mjs';

const plan = { revisionFile: 'build-id.txt', checks: [{ id: 'save', expected: 'saved', evidence: ['log'] }] };
const planned = { type: 'planned', summary: '写入验收计划', planFile: 'plan.json' };
const developed = { type: 'developed', summary: '完成实现' };
const missing = { type: 'tested', revision: 'r1', resultsFile: 'missing.json' };
const finish = (store, request, event) => finishHostStep(store, { ...request, event });

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'harness-runner-'));
  const previous = process.env.AGENT_HARNESS_STATE_DIR;
  process.env.AGENT_HARNESS_STATE_DIR = join(root, 'state');
  t.after(() => {
    if (previous === undefined) delete process.env.AGENT_HARNESS_STATE_DIR;
    else process.env.AGENT_HARNESS_STATE_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const project = join(root, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'plan.json'), JSON.stringify(plan));
  writeFileSync(join(project, 'build-id.txt'), 'r1');
  const store = storeFor(project, 'task');
  store.create(createTask({ id: 'task', project, objective: '保存变更' }));
  return { root, project, store };
}

test('a repair after two measured failures always reaches verification even without recovery metadata', async t => {
  const { root, project, store } = fixture(t);
  const driver = join(root, 'driver.mjs');
  const literal = 'a b; $(unchanged)';
  writeFileSync(driver, `
    import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
    const { state, mode, actionId } = JSON.parse(readFileSync(0, 'utf8'));
    if (process.argv[2] !== ${JSON.stringify(literal)}) process.exit(80);
    appendFileSync('calls.txt', state.phase + ' ' + mode + ' ' + actionId + '\\n');
    let event;
    if (state.phase === 'plan') event = ${JSON.stringify(planned)};
    if (state.phase === 'develop') {
      const failures = state.history.filter(row => row.test?.outcome === 'failed').length;
      writeFileSync('work.txt', failures >= 2 ? 'saved' : 'broken');
      writeFileSync('build-id.txt', 'build-' + state.seq);
      event = ${JSON.stringify(developed)};
    }
    if (state.phase === 'verify') {
      const actual = readFileSync('work.txt', 'utf8');
      const revision = readFileSync('build-id.txt', 'utf8');
      writeFileSync('test.log', actual);
      writeFileSync('results.json', JSON.stringify({ planId: state.plan.planId, revision,
        checks: [{ id: 'save', actual, status: actual === 'saved' ? 'passed' : 'failed', evidence: { log: 'test.log' } }] }));
      event = { type: 'tested', resultsFile: 'results.json', revision };
    }
    console.log(JSON.stringify(event));
  `);
  const state = await runWorkflow(store, [process.execPath, driver, literal]);
  assert.equal(state.phase, 'done');
  assert.deepEqual(state.history.filter(row => row.test).map(row => row.test.outcome), ['failed', 'failed', 'passed']);
  const calls = readFileSync(join(project, 'calls.txt'), 'utf8').trim().split('\n').map(row => row.split(' '));
  assert.deepEqual(calls.map(row => row[0]), ['plan', 'develop', 'verify', 'develop', 'verify', 'develop', 'verify']);
  assert.ok(calls.every(row => row[1] === 'execute'));
  assert.equal(new Set(calls.map(row => row[2])).size, calls.length);
  assert.equal((await beginHostStep(store)).mode, 'done');
});

test('an unknown side effect survives a human question, and only positive proof permits a new execute', async t => {
  const { store } = fixture(t);
  const original = await beginHostStep(store);
  const uncertain = await beginHostStep(store);
  assert.equal(uncertain.mode, 'reconcile');
  assert.equal(uncertain.actionId, original.actionId);
  let state = await finish(store, uncertain, { type: 'ask', question: '请提供原执行日志' });
  assert.equal((await beginHostStep(store)).mode, 'waiting');
  state = await applyManualEvent(store,
    { type: 'answer', decisionId: state.question.decisionId, answer: '查本地队列的终态记录' }, state.seq);
  const followup = await beginHostStep(store);
  assert.equal(followup.mode, 'reconcile');
  assert.deepEqual(followup.originalState, original.state);
  assert.equal(followup.actionId, original.actionId);
  assert.equal(followup.state.lastDecision.answer, '查本地队列的终态记录');
  await assert.rejects(finish(store, followup, { type: 'not_executed' }), /证据/);
  await finish(store, followup, { type: 'not_executed', evidence: '原执行槽已关闭且无受理记录' });
  const retry = await beginHostStep(store);
  assert.equal(retry.actionId, original.actionId);
  assert.equal(retry.mode, 'execute');
  assert.equal((await finish(store, retry, planned)).phase, 'develop');
  await assert.rejects(finish(store, retry, planned), /actionId/);
});

test('a known checkpoint is replayable; uncertain checkpoints retain the original read-only action', async t => {
  const { store } = fixture(t);
  await beginHostStep(store);
  const uncertain = await beginHostStep(store);
  await finish(store, uncertain, { type: 'reconciled', evidence: '检查点回执已落盘',
    event: { type: 'checkpoint', summary: '已梳理范围' } });
  const next = await beginHostStep(store);
  assert.equal(next.mode, 'execute');
  assert.notEqual(next.actionId, uncertain.actionId);
  const reconciling = await beginHostStep(store);
  const checkpoint = { type: 'checkpoint', summary: '已找到队列；读取它的历史回执' };
  await finish(store, reconciling, checkpoint);
  const followup = await beginHostStep(store);
  assert.equal(followup.mode, 'reconcile');
  assert.equal(followup.actionId, reconciling.actionId);
  await finish(store, followup, checkpoint);
  await finish(store, await beginHostStep(store), checkpoint);
  await assert.rejects(beginHostStep(store), { code: 'EDRIVERSTALLED' });
  const resumed = await beginHostStep(store);
  assert.equal(resumed.mode, 'reconcile');
  assert.equal(resumed.actionId, reconciling.actionId);
});

for (const afterCommit of [false, true]) {
  test('a durable receipt recovers even when the process stops ' + (afterCommit ? 'after' : 'before') + ' state commit', async t => {
    const { store, project, root } = fixture(t);
    const driver = join(root, 'driver.mjs');
    writeFileSync(driver, `
      import { readFileSync, appendFileSync } from 'node:fs';
      const request = JSON.parse(readFileSync(0, 'utf8'));
      appendFileSync('dispatches', request.mode + '\\n');
      console.log(JSON.stringify(${JSON.stringify(planned)}));
    `);
    const commit = store.commit;
    store.commit = (seq, next) => {
      if (afterCommit) commit(seq, next);
      throw new Error('模拟提交中断');
    };
    await assert.rejects(runWorkflow(store, [process.execPath, driver]), /模拟提交中断/);
    assert.equal(readFileSync(join(project, 'dispatches'), 'utf8'), 'execute\n');
    store.commit = commit;
    writeFileSync(join(project, 'plan.json'), 'broken now');
    const next = await beginHostStep(store);
    assert.equal(next.mode, 'execute');
    assert.equal(next.state.phase, 'develop');
    assert.deepEqual(next.state.plan.snapshot.checks, plan.checks);
    assert.equal(next.state.history.length, 1);
  });
}

test('resuming a failed command reconciles its action and refuses driver-supplied control events', async t => {
  const { root, store } = fixture(t);
  const driver = join(root, 'driver.mjs');
  writeFileSync(driver, `import { readFileSync } from 'node:fs'; readFileSync(0); console.log("not JSON");`);
  await assert.rejects(runWorkflow(store, [process.execPath, driver]), /JSON/);
  const request = await beginHostStep(store);
  assert.equal(request.mode, 'reconcile');
  await assert.rejects(finish(store, request, { type: 'answer', answer: 'ok' }), /工作结果/);
  await assert.rejects(finish(store, request, { type: 'done' }), /工作结果/);
  await assert.rejects(applyManualEvent(store, planned), /尚未结清/);
  await assert.rejects(finish(store, { ...request, stepId: 'stale' }, planned), /stepId/);
  assert.equal((await finish(store, request, planned)).seq, 1);
});

test('a missing executable can be corrected without pretending an action ran', async t => {
  const { store, root } = fixture(t);
  await assert.rejects(runWorkflow(store, [join(root, 'not-found')]), { code: 'ENOENT' });
  assert.equal((await beginHostStep(store)).mode, 'execute');
});

test('repeated incomplete verification with no new remedy yields a recoverable technical error', async t => {
  const { store } = fixture(t);
  for (const event of [planned, developed, missing, missing]) {
    await finish(store, await beginHostStep(store), event);
  }
  const retry = await beginHostStep(store);
  assert.ok(retry.recovery.problem);
  assert.deepEqual(retry.recovery.previous, []);
  const remedy = { diagnosis: '结果落在旧目录', strategy: '按构建的产物目录重取' };
  await finish(store, retry, { ...missing, recovery: remedy });
  const again = await beginHostStep(store);
  assert.deepEqual(again.recovery.previous, [remedy]);
  await finish(store, again, { ...missing, recovery: remedy });
  await assert.rejects(beginHostStep(store), { code: 'EDRIVERSTALLED' });
  const retryAfterStall = await beginHostStep(store);
  assert.equal(retryAfterStall.state.phase, 'verify');
  assert.equal(retryAfterStall.state.question, null);
  assert.deepEqual(retryAfterStall.recovery.previous, [remedy]);
});

test('a late not_executed response cannot release a newer dispatch of the same action', async t => {
  const { store } = fixture(t);
  const original = await beginHostStep(store);
  const stale = await beginHostStep(store);
  const verifier = await beginHostStep(store);
  const absent = { type: 'not_executed', evidence: '原执行者已经退出，日志无受理' };
  await assert.rejects(finish(store, stale, absent), /dispatchId/);
  await finish(store, verifier, absent);
  const retry = await beginHostStep(store);
  const newest = await beginHostStep(store);
  assert.equal(retry.mode, 'execute');
  assert.equal(newest.mode, 'reconcile');
  assert.equal(newest.actionId, original.actionId);
  assert.notEqual(newest.dispatchId, stale.dispatchId);
  await assert.rejects(finish(store, stale, absent), /dispatchId/);
  await assert.rejects(finish(store, verifier, absent), /dispatchId/);
  assert.equal((await finish(store, newest, planned)).phase, 'develop');
});

test('ordinary questions resume a new action, while uncertain side effects must first reconcile', async t => {
  const { store } = fixture(t);
  const first = await beginHostStep(store);
  let state = await finish(store, first, { type: 'ask', question: '本次范围？' });
  await applyManualEvent(store, { type: 'answer', answer: '保存', decisionId: state.question.decisionId });
  const next = await beginHostStep(store);
  assert.notEqual(next.actionId, first.actionId);
  assert.equal(next.mode, 'execute');
  state = await finish(store, next, { type: 'ask', uncertainEffect: true, question: '先前已发出的工单存在哪里？' });
  await applyManualEvent(store, { type: 'answer', answer: '已在本地队列留档', decisionId: state.question.decisionId });
  await assert.rejects(finish(store, next, planned), /dispatchId/);
  const check = await beginHostStep(store);
  assert.equal(check.mode, 'reconcile');
  assert.equal(check.actionId, next.actionId);
  assert.deepEqual(check.originalState, next.state);
});

for (const broken of ['malformed', 'nonzero', 'unknown-event', 'missing-field']) {
  test('one run automatically reconciles an executed action after ' + broken + ' driver output', async t => {
    const { root, project, store } = fixture(t);
    const driver = join(root, 'driver.mjs');
    writeFileSync(driver, `
      import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
      const { state, mode, actionId } = JSON.parse(readFileSync(0, 'utf8'));
      appendFileSync('trace', JSON.stringify({ phase: state.phase, actionId, mode }) + '\\n');
      if (state.phase === 'plan' && mode === 'execute') {
        writeFileSync('applied', JSON.stringify(${JSON.stringify(planned)}), { flag: 'wx' });
        if (process.argv[2] === 'nonzero') process.exit(7);
        if (process.argv[2] === 'unknown-event') console.log(JSON.stringify({ type: 'done' }));
        else if (process.argv[2] === 'missing-field') console.log(JSON.stringify({ type: 'planned' }));
        else console.log('missing JSON');
      } else if (state.phase === 'plan' && mode === 'reconcile') {
        console.log(readFileSync('applied', 'utf8'));
      } else {
        console.log(JSON.stringify({ type: 'ask', question: '选择输出格式' }));
      }
    `);
    const final = await runWorkflow(store, [process.execPath, driver, broken]);
    assert.equal(final.phase, 'waiting');
    const trace = readFileSync(join(project, 'trace'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(trace.map(({ phase, mode }) => [phase, mode]),
      [['plan', 'execute'], ['plan', 'reconcile'], ['develop', 'execute']]);
    assert.equal(trace[0].actionId, trace[1].actionId);
  });
}
