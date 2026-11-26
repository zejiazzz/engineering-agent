import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const adapter = fileURLToPath(new URL('../workflow-host.mjs', import.meta.url));

for (const host of ['codex', 'claude-code']) {
  for (const mode of ['execute', 'reconcile']) {
    test(`native ${host} bridge uses the ${mode} protocol and tools`, { skip: process.platform === 'win32' }, t => {
      const dir = mkdtempSync(join(tmpdir(), 'workflow-host-'));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      const binary = join(dir, host === 'codex' ? 'codex' : 'claude');
      writeFileSync(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const prompt = fs.readFileSync(0, 'utf8');
fs.writeFileSync('call.json', JSON.stringify({args, prompt, worker: process.env.AGENT_HARNESS_LOOP_WORKER}));
const event = JSON.stringify({type: 'ask', question: 'choose'});
if (args[0] === 'exec') fs.writeFileSync(args[args.indexOf('-o') + 1], event);
else console.log(JSON.stringify({is_error: false, result: event}));
`, { mode: 0o700 });
      const request = { mode, actionId: 'one', dispatchId: 'two', state: { project: dir } };
      const result = spawnSync(process.execPath, [adapter, host], {
        cwd: dir, encoding: 'utf8', input: JSON.stringify(request),
        env: { ...process.env, PATH: dir + delimiter + process.env.PATH, AGENT_HARNESS_CODEX_MODEL: 'local-model' },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).type, 'ask');
      const { args, prompt, worker } = JSON.parse(readFileSync(join(dir, 'call.json'), 'utf8'));
      assert.equal(worker, '1');
      assert.ok(prompt.includes('"actionId":"one"'));
      assert.ok(!args.some(arg => arg.includes('bypass')));
      if (host === 'codex') {
        assert.equal(args[args.indexOf('--sandbox') + 1], mode === 'reconcile' ? 'read-only' : 'workspace-write');
        assert.equal(args[args.indexOf('--model') + 1], 'local-model');
      } else {
        assert.equal(args.includes('Read,Glob,Grep'), mode === 'reconcile');
      }
    });
  }
}
