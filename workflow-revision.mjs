import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { isPrivateFile } from './verify.mjs';

export function inside(root, file) {
  const tail = relative(root, file);
  return tail !== '..' && !tail.startsWith(`..${sep}`) && !isAbsolute(tail);
}

/** 每次使用前重查真实定位，包括计划锁定后替换的符号链接。 */
export function projectFile(project, file, name, privateRoot) {
  const root = realpathSync.native(project);
  if (!inside(project, file) && !inside(root, file)) throw new Error(`${name} 必须位于当前项目目录内`);
  const target = realpathSync.native(file);
  if (!inside(root, target)) throw new Error(`${name} 链接超出当前项目目录`);
  if (privateRoot && isPrivateFile(privateRoot, target)) throw new Error(`${name} 不能来自工作流状态目录`);
  return target;
}

export function protocolError(message) {
  return Object.assign(new Error(message), { code: 'EDRIVERPROTOCOL' });
}

function sourcePath(project, value) {
  if (typeof value !== 'string' || !value.trim() || isAbsolute(value) || win32.isAbsolute(value)) {
    throw protocolError('版本来源必须是非空的项目相对文件路径');
  }
  const full = resolve(project, value);
  if (full === project || !inside(project, full)) throw protocolError('版本来源超出项目目录');
  return relative(project, full);
}

/** 计划在开发前固定版本来源，文件内容在每次验收时独立读取。 */
export function sourceFrom(project, value) {
  const { revisionFile, revisionInputs } = value;
  if (revisionFile === undefined && revisionInputs === undefined) return null;
  if (revisionFile !== undefined && revisionInputs !== undefined) throw protocolError('版本来源只可选择一种');
  if (revisionFile !== undefined) return { revisionFile: sourcePath(project, revisionFile) };
  if (!Array.isArray(revisionInputs) || !revisionInputs.length) throw protocolError('revisionInputs 必须是非空文件列表');
  const paths = revisionInputs.map(path => sourcePath(project, path)).sort();
  if (new Set(paths).size !== paths.length) throw protocolError('revisionInputs 不能包含重复文件');
  return { revisionInputs: paths };
}

function identity(stat) {
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}

export function manifestIdentity(file) {
  return identity(statSync(file, { bigint: true }));
}

/** 开发后才生成的制品可以暂缺，已有版本来源必须是项目内的独立普通文件。 */
export function checkPlannedSource(project, source, planFile, privateRoot) {
  for (const path of source.revisionInputs || [source.revisionFile]) {
    try {
      const target = projectFile(project, resolve(project, path), '版本来源', privateRoot);
      const stat = statSync(target, { bigint: true });
      if (!stat.isFile() || identity(stat) === manifestIdentity(planFile)) {
        throw protocolError('版本来源须为独立于计划的普通文件');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

/** 从已绑定构建标识或输入文件取得版本，附加参数供引擎排除本次结果和状态目录。 */
export function currentRevision(state, resultsFile, privateRoot = state.plan?.privateRoot) {
  const source = state.plan?.revisionSource;
  if (!source) throw new Error('此计划缺少独立版本来源，请请求人工批准重排并绑定 revisionFile 或 revisionInputs');
  const manifests = new Set([state.plan.planFile]);
  if (resultsFile) manifests.add(resultsFile);
  const excluded = new Set();
  for (const item of state.history) {
    for (const manifest of [item.plan, item.test]) {
      if (!manifest?.manifestIdentity) continue;
      excluded.add(manifest.manifestIdentity);
      manifests.add(manifest.planFile || manifest.resultsFile);
    }
  }
  for (const path of [state.plan.planFile, resultsFile].filter(Boolean)) {
    excluded.add(manifestIdentity(projectFile(state.project, path, '清单', privateRoot)));
  }
  const inputs = [];
  for (const path of source.revisionInputs || [source.revisionFile]) {
    if (manifests.has(resolve(state.project, path))) throw new Error('版本来源不可使用计划或结果清单');
    const target = projectFile(state.project, resolve(state.project, path), '版本来源', privateRoot);
    const fd = openSync(target, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile() || excluded.has(identity(before))) throw new Error('版本来源须是独立于计划和结果清单的普通文件');
      if (source.revisionFile) {
        if (before.size > 4096n) throw new Error('revisionFile 只应包含单行构建标识');
        const id = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(fd)).trim();
        if (!id || /[\x00-\x1f\x7f]/u.test(id) || /^[\[{]/u.test(id)) throw new Error('revisionFile 应包含单行构建标识');
        return id;
      }
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let count;
      while ((count = readSync(fd, buffer, 0, buffer.length, null)) !== 0) hash.update(buffer.subarray(0, count));
      const after = fstatSync(fd, { bigint: true });
      if (before.ctimeNs !== after.ctimeNs || before.size !== after.size) throw new Error('计算版本时文件发生变化，请重试');
      inputs.push([path.split(sep).join('/'), hash.digest('hex')]);
    } finally {
      closeSync(fd);
    }
  }
  return createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
}
