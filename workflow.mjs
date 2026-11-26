import { readFileSync, realpathSync } from 'node:fs';
import { extname, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTask, currentRevision, view } from './workflow-engine.mjs';
import { storeFor, listTasks } from './workflow-store.mjs';
import { runWorkflow, beginHostStep, finishHostStep, applyManualEvent } from './workflow-runner.mjs';

const usage = [
  'start ID "目标" [--host codex|claude-code | -- /可信的驱动程序]',
  'list', 'status ID', 'fingerprint ID', 'resume [ID]', 'finish ID < receipt.json',
  'answer ID DECISION_ID "人工答复" [--approve-replan|--keep-plan]',
].join('\n');

function requireArg(ok, message = usage) {
  if (!ok) throw new Error(message);
}

function projectRoot() {
  const cwd = realpathSync(process.cwd());
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  return git.status === 0 ? realpathSync(git.stdout.trimEnd()) : cwd;
}

function executorFrom(args) {
  if (!args.length) return { kind: 'session' };
  if (args[0] === '--host' && args.length === 2 && ['codex', 'claude-code'].includes(args[1]))
    return { kind: 'host', host: args[1] };
  if (args[0] === '--' && args.length === 2 && isAbsolute(args[1]))
    return { kind: 'command', file: realpathSync(args[1]) };
  throw new Error(usage);
}

// 驱动绑定来自建任务时的宿主选择；需求文件和步骤回执均无权更换执行程序。
async function drive(store, command) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    return await runWorkflow(store, command, { signal: controller.signal });
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  }
}

async function dispatch(store) {
  const state = store.read();
  const executor = state.executor;
  if (executor.kind === 'session') return beginHostStep(store);
  if (executor.kind === 'command') {
    const js = ['.js', '.cjs', '.mjs'].includes(extname(executor.file));
    return drive(store, js ? [process.execPath, executor.file] : [executor.file]);
  }
  requireArg(executor.kind === 'host' && ['codex', 'claude-code'].includes(executor.host), '无效的宿主绑定');
  const adapter = fileURLToPath(new URL('./workflow-host.mjs', import.meta.url));
  return drive(store, [process.execPath, adapter, executor.host]);
}

async function main([command, ...args]) {
  if (command === '--help' || command === 'help') return usage;
  const project = projectRoot();
  if (command === 'list') {
    requireArg(!args.length);
    return listTasks(project);
  }
  let [id, ...rest] = args;
  if (command === 'resume' && !id) {
    const active = listTasks(project).filter(task => task.phase !== 'done');
    requireArg(active.length === 1, active.length ? '当前有多个任务，请用 list 核对目标并指定 ID。' : '当前项目没有待续任务。');
    id = active[0].id;
  }
  requireArg(typeof id === 'string' && id.length > 0);
  const store = storeFor(project, id);
  if (command === 'start') {
    const [objective, ...options] = rest;
    requireArg(objective?.trim());
    store.create({ ...createTask({ id, objective, project }), executor: executorFrom(options) });
    return dispatch(store);
  }
  if (command === 'status' && !rest.length) return view(store.read());
  if (command === 'fingerprint' && !rest.length) return currentRevision(store.read());
  if (command === 'resume' && !rest.length) return dispatch(store);
  if (command === 'finish' && !rest.length) {
    requireArg(store.read().executor.kind === 'session', '此任务由绑定的外部宿主执行。');
    const { stepId, actionId, dispatchId, event } = JSON.parse(readFileSync(0, 'utf8'));
    await finishHostStep(store, { stepId, actionId, dispatchId, event });
    return dispatch(store);
  }
  if (command === 'answer') {
    const [decisionId, answer, flag] = rest;
    requireArg((rest.length === 2 || rest.length === 3) && decisionId && answer?.trim());
    const event = { type: 'answer', decisionId, answer };
    if (flag !== undefined) {
      requireArg(['--approve-replan', '--keep-plan'].includes(flag));
      event.choice = flag.slice(2);
    }
    await applyManualEvent(store, event, store.read().seq);
    return dispatch(store);
  }
  throw new Error(usage);
}

try {
  const output = await main(process.argv.slice(2));
  console.log(typeof output === 'string' ? output : JSON.stringify(output, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
