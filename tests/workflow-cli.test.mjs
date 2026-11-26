import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const cli = fileURLToPath(new URL('../workflow.mjs', import.meta.url));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'workflow-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'example');
  mkdirSync(project);
  const env = { ...process.env, AGENT_HARNESS_STATE_DIR: join(root, 'state') };
  const run = (args, input) => spawnSync(process.execPath, [cli, ...args], {
    cwd: project, env, encoding: 'utf8', input: input && JSON.stringify(input), timeout: 30000,
  });
  const ok = (args, input) => {
    const result = run(args, input);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  return { project, root, run, ok };
}

test('start pauses for a real decision and a new process automatically develops, repairs, verifies and finishes', t => {
  const { root, project, run, ok } = fixture(t);
  const script = join(root, 'agent.mjs');
  writeFileSync(script, `
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const { state, mode, actionId } = JSON.parse(readFileSync(0, 'utf8'));
if (mode !== 'execute') throw new Error('unexpected reconcile');
appendFileSync('events.log', state.phase + ' ' + actionId + '\\n');
let event;
if (state.phase === 'plan' && !state.lastDecision) {
  event = { type:'ask', question:'Which title format?' };
} else if (state.phase === 'plan') {
  if (state.lastDecision.answer !== 'keep case') throw new Error('lost decision');
  writeFileSync('plan.json', JSON.stringify({ checks:[{id:'reopen',expected:'read back New',evidence:['test']}] }));
  event = { type:'planned', planFile:'plan.json', revisionFile:'build-id.txt', summary:'preserve case' };
} else if (state.phase === 'develop') {
  writeFileSync('title.txt', state.lastTest ? 'New' : 'Old');
  writeFileSync('build-id.txt', state.lastTest ? 'New' : 'Old');
  event = { type:'developed', summary:'implemented title save' };
} else {
  const title = readFileSync('title.txt','utf8');
  const status = title === 'New' ? 'passed' : 'failed';
  const file = 'observed-' + state.seq + '.txt';
  writeFileSync(file, 'read back ' + title);
  writeFileSync('results.json', JSON.stringify({ planId:state.plan.planId, revision:title,
    checks:[{id:'reopen',status,actual:title,evidence:{test:file}}] }));
  event = { type:'tested', resultsFile:'results.json', revision:title };
}
console.log(JSON.stringify(event));
`);
  const waiting = ok(['start', 'title', 'save the title', '--', script]);
  assert.equal(waiting.phase, 'waiting');
  assert.equal(ok(['resume']).question.decisionId, waiting.question.decisionId);
  assert.equal(run(['answer','title','wrong-id','keep case']).status, 2);
  const finished = ok(['answer','title',waiting.question.decisionId,'keep case']);
  assert.equal(finished.phase, 'done');
  assert.deepEqual(finished.history.filter(row => row.type === 'tested').map(row => row.test.outcome), ['failed','passed']);
  const effects = readFileSync(join(project,'events.log'),'utf8');
  assert.equal(ok(['resume','title']).phase, 'done');
  assert.equal(readFileSync(join(project,'events.log'),'utf8'), effects);
  assert.equal(ok(['status','title']).lastDecision.answer, 'keep case');
});

test('interactive recovery preserves the action identity across fresh processes and rejects stale responses', t => {
  const { ok, run } = fixture(t);
  const a = ok(['start', 'single', 'resume this task']);
  assert.equal(a.mode, 'execute');
  const resumed = ok(['resume']);
  assert.equal(resumed.mode, 'reconcile');
  assert.equal(resumed.actionId, a.actionId);
  assert.equal(run(['finish','single'], {...a, actionId:'old',event:{type:'ask',question:'choose'}}).status, 2);
  const after = ok(['finish','single'], { stepId:resumed.stepId, actionId:resumed.actionId, dispatchId:resumed.dispatchId, event:{
    type:'reconciled', evidence:'saved original question', event:{type:'ask',question:'choose size'}
  }});
  assert.equal(after.mode, 'waiting');
  const next = ok(['answer','single',after.state.question.decisionId,'small']);
  assert.equal(next.mode, 'execute');
  assert.equal(next.state.phase, 'plan');
  assert.equal(next.state.lastDecision.answer, 'small');
});
