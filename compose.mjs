import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const manifestName = '.agent-harness.json';
const harnessRoot = realpathSync(fileURLToPath(new URL('.', import.meta.url)));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function checkFields(value, fields, label) {
  assert(
    value && typeof value === 'object' && !Array.isArray(value),
    `${label} 必须是对象`
  );
  for (const field of Object.keys(value)) {
    assert(fields.includes(field), `${label} 含未知字段 ${field}`);
  }
}

// 只解析仓库内的普通文件，同时核对符号链接解析后的目录边界。
function projectFile(root, file, label) {
  assert(
    typeof file === 'string' &&
      !isAbsolute(file) &&
      !/[:\\]/.test(file) &&
      file.split('/').every(part => part && part !== '.' && part !== '..'),
    `${label} 必须使用项目内相对路径`
  );
  try {
    const target = realpathSync(resolve(root, file));
    const location = relative(root, target);
    assert(
      !isAbsolute(location) &&
        location !== '..' &&
        !location.startsWith(`..${sep}`)
    );
    assert(statSync(target).isFile());
    return target;
  } catch {
    throw new Error(`${label} 无法读取项目内普通文件 ${file}`);
  }
}

function readManifest(root, name, optional = false) {
  try {
    lstatSync(resolve(root, name));
  } catch (error) {
    if (optional && error.code === 'ENOENT') return { schemaVersion: 1 };
    throw error;
  }

  const file = projectFile(root, name, '插件清单');
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`无法读取或解析 ${name}`);
  }
}

function readPlugins(manifest, fields, label) {
  checkFields(manifest, fields, label);
  const { schemaVersion, plugins = [] } = manifest;
  assert(schemaVersion === 1, `${label}仅支持 schemaVersion 1`);
  assert(Array.isArray(plugins), `${label}的 plugins 必须是数组`);
  const registered = new Map();
  for (const [index, plugin] of plugins.entries()) {
    const itemLabel = `${label}.plugins[${index}]`;
    checkFields(
      plugin,
      ['id', 'when', 'entry', 'adapter', 'enabled'],
      itemLabel
    );
    const { id, enabled } = plugin;
    assert(
      typeof id === 'string' && /^[a-z][a-z0-9-]*$/.test(id),
      `${itemLabel}.id 格式错误`
    );
    assert(!registered.has(id), `插件 ID 重复 ${id}`);
    assert(
      enabled === undefined || typeof enabled === 'boolean',
      `${itemLabel}.enabled 必须是布尔值`
    );
    registered.set(id, plugin);
  }
  return registered;
}

function compose(root, selected) {
  const core = projectFile(harnessRoot, 'core.md', '核心入口');
  const defaults = readPlugins(
    readManifest(harnessRoot, 'defaults.json'),
    ['schemaVersion', 'plugins'],
    '共用清单'
  );
  const manifest = readManifest(root, manifestName, true);
  const overrides = readPlugins(
    manifest,
    ['schemaVersion', 'profile', 'plugins'],
    '项目清单'
  );
  const entries = [core];
  if (manifest.profile !== undefined)
    entries.push(projectFile(root, manifest.profile, '项目约定'));

  const enabled = new Set();
  for (const id of new Set([...overrides.keys(), ...defaults.keys()])) {
    const project = overrides.get(id);
    const shared = defaults.get(id);
    if (project?.enabled === false) {
      assert(shared, `插件 ${id} 没有可关闭的共用定义`);
      continue;
    }
    const when = project?.when === undefined ? shared?.when : project.when;
    assert(
      typeof when === 'string' && when.trim(),
      `插件 ${id} 缺少任务触发条件`
    );
    const usesProjectEntry = project?.entry !== undefined;
    const entry = projectFile(
      usesProjectEntry ? root : harnessRoot,
      usesProjectEntry ? project.entry : shared?.entry,
      `插件 ${id} 的入口`
    );
    const adapter =
      project?.adapter === undefined
        ? undefined
        : projectFile(root, project.adapter, `插件 ${id} 的项目适配器`);
    enabled.add(id);
    if (selected.includes(id)) {
      entries.push(entry);
      if (adapter !== undefined) entries.push(adapter);
    }
  }
  for (const id of selected)
    assert(enabled.has(id), `当前项目未启用插件 ${id}`);
  return [...new Set(entries)];
}

try {
  const entries = compose(realpathSync(process.cwd()), process.argv.slice(2));
  console.log(JSON.stringify(entries, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
