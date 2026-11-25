import {
  closeSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { hostIds, hostPlan } from "./host-adapters.mjs";

const source = fileURLToPath(new URL(".", import.meta.url));
const bundleMarker = ".business-agent-managed";
const sectionStart = "<!-- business-agent:start -->";
const sectionEnd = "<!-- business-agent:end -->";
const bundleFiles = [
  "README.md",
  "INSTALL.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "core.md",
  "defaults.json",
  "compose.mjs",
  "codex-global.md",
  "plugins/auto-commit.md",
  "plugins/code-review.md",
  "plugins/frontend-standards.md",
  "plugins/frontend/structure.md",
  "plugins/frontend/design.md",
  "plugins/feishu-defects.md",
  "plugins/talk-live-verification.md",
  "plugins/talk/ledger.cjs",
  "plugins/talk/run-cases.cjs",
];

function inspect(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

// 通过已存在的祖先解析符号链接，避免两个配置路径落到同一目录。
function physicalPath(path) {
  if (inspect(path)) return realpathSync(path);
  const parent = dirname(path);
  if (parent === path) return path;
  return join(physicalPath(parent), relative(parent, path));
}

function previousFile(path) {
  const info = inspect(path);
  if (!info) return undefined;
  if (!info.isFile()) throw new Error("配置目标必须是普通文件：" + path);
  return { bytes: readFileSync(path), mode: info.mode & 0o777 };
}

function addInstructions(old, content, path, hostId) {
  if (old.includes("<!-- ai-rules:generated")) {
    throw new Error(
      path +
        " 由规则生成器维护。" +
        (hostId === "codex"
          ? "登记 codex-global.md 到其来源。"
          : "在生成源登记读取研发 Agent 共享包 core.md 的入口。") +
        "再用 --bundle-only 安装。"
    );
  }
  const section = sectionStart + "\n\n" + content.trim() + "\n" + sectionEnd;
  const start = old.indexOf(sectionStart);
  const end = old.indexOf(sectionEnd);
  const markers = old.match(/<!-- business-agent:/g)?.length ?? 0;
  if (markers && (markers !== 2 || start < 0 || end < start)) {
    throw new Error("研发 Agent 入口标记不完整或重复：" + path);
  }
  if (markers)
    return old.slice(0, start) + section + old.slice(end + sectionEnd.length);
  if (!old) return section + "\n";
  const gap = old.endsWith("\n\n") ? "" : old.endsWith("\n") ? "\n" : "\n\n";
  return old + gap + section + "\n";
}

function planFiles(plan) {
  if (
    plan.id === "codex" &&
    plan.outputs.some((item) => item.kind === "instructions")
  ) {
    const override = previousFile(join(plan.root, "AGENTS.override.md"));
    if (override?.bytes.toString().trim()) {
      throw new Error(
        "Codex 的 AGENTS.override.md 生效。请在其来源登记入口，再使用 --bundle-only。"
      );
    }
  }
  return plan.outputs.map((output) => {
    if (
      output.kind === "instructions" &&
      inspect(output.path)?.isSymbolicLink()
    ) {
      throw new Error(
        "全局指令由符号链接维护：" +
          output.path +
          "。请保留其来源并使用 --bundle-only。"
      );
    }
    const before = previousFile(output.path);
    const old = before?.bytes.toString("utf8") ?? "";
    if (output.kind === "managed" && before) {
      const markers = ["# " + output.marker, "<!-- " + output.marker + " -->"];
      if (!old.split(/\r?\n/).some((line) => markers.includes(line))) {
        throw new Error("现有配置由其他方式维护：" + output.path);
      }
    }
    const content =
      output.kind === "instructions"
        ? addInstructions(old, output.content, output.path, plan.id)
        : output.content;
    return { path: output.path, before, bytes: Buffer.from(content) };
  });
}

/** 在目标文件的同一目录内原子替换，支持不同磁盘上的宿主配置。 */
function writeAtomic(path, bytes, mode) {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });
  const temp = mkdtempSync(join(parent, ".engineering-agent-"));
  try {
    const candidate = join(temp, "file");
    writeFileSync(candidate, bytes, { mode });
    renameSync(candidate, path);
  } finally {
    rmSync(temp, { force: true, recursive: true });
  }
}

function prepareBundle(directory) {
  for (const file of bundleFiles) {
    const input = join(source, file);
    if (!inspect(input)?.isFile()) throw new Error("发布文件缺失：" + file);
    const output = join(directory, file);
    mkdirSync(dirname(output), { recursive: true });
    copyFileSync(input, output);
  }
  writeFileSync(join(directory, bundleMarker), "business-agent\n");
}

function publish(packageDir, plan) {
  const current = inspect(packageDir);
  if (
    current &&
    (!current.isDirectory() ||
      !inspect(join(packageDir, bundleMarker))?.isFile())
  ) {
    throw new Error("共享目录已存在且由其他方式维护：" + packageDir);
  }

  const outputs = planFiles(plan);
  const stage = mkdtempSync(
    join(dirname(packageDir), ".engineering-agent-bundle-")
  );
  const candidate = join(stage, "bundle");
  const backup = join(stage, "previous");
  const applied = [];
  let published = false;
  let keepStage = false;
  try {
    prepareBundle(candidate);
    if (current) renameSync(packageDir, backup);
    try {
      renameSync(candidate, packageDir);
      published = true;
      for (const file of outputs) {
        const now = previousFile(file.path);
        if (
          Boolean(now) !== Boolean(file.before) ||
          (now && !now.bytes.equals(file.before.bytes))
        ) {
          throw new Error("安装期间配置发生变化：" + file.path);
        }
        if (now?.bytes.equals(file.bytes)) continue;
        writeAtomic(file.path, file.bytes, file.before?.mode ?? 0o644);
        applied.push(file);
      }
    } catch (error) {
      const restoreErrors = [];
      for (const file of applied.reverse()) {
        try {
          const now = previousFile(file.path);
          if (!now?.bytes.equals(file.bytes))
            throw new Error("配置已被其他操作修改，已保留当前内容");
          if (file.before)
            writeAtomic(file.path, file.before.bytes, file.before.mode);
          else unlinkSync(file.path);
        } catch (err) {
          keepStage = true;
          if (file.before) {
            writeFileSync(
              join(stage, "restore-" + restoreErrors.length),
              file.before.bytes,
              { mode: file.before.mode }
            );
            restoreErrors.push(
              file.path +
                "（副本 restore-" +
                restoreErrors.length +
                "）：" +
                err.message
            );
          } else {
            restoreErrors.push(file.path + "：" + err.message);
          }
        }
      }
      try {
        if (published) renameSync(packageDir, candidate);
        if (current) renameSync(backup, packageDir);
      } catch (err) {
        restoreErrors.push(packageDir + "：" + err.message);
      }
      if (restoreErrors.length) {
        keepStage = true;
        throw new Error(
          error.message +
            "；恢复失败，保留 " +
            stage +
            "\n" +
            restoreErrors.join("\n")
        );
      }
      throw error;
    }
  } finally {
    if (!keepStage) rmSync(stage, { force: true, recursive: true });
  }
}

function parse(argv) {
  const options = {};
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (seen.has(flag)) throw new Error("参数重复：" + flag);
    seen.add(flag);
    if (flag === "--host" || flag === "--host-dir") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--"))
        throw new Error("缺少参数值：" + flag);
      options[flag === "--host" ? "host" : "hostDir"] = value;
      index += 1;
    } else if (
      flag === "--bundle-only" ||
      flag === "--dry-run" ||
      flag === "--help"
    ) {
      options[
        {
          "--bundle-only": "bundleOnly",
          "--dry-run": "dryRun",
          "--help": "help",
        }[flag]
      ] = true;
    } else {
      throw new Error("未知选项：" + flag);
    }
  }
  return options;
}

function install(packageDir, plan) {
  const parent = dirname(packageDir);
  mkdirSync(parent, { recursive: true });
  const lock = join(parent, ".engineering-agent-install.lock");
  let descriptor;
  try {
    descriptor = openSync(lock, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(
        "已有安装锁：" + lock + "。请按接入指南检查进程和上版目录。"
      );
    throw error;
  }
  try {
    writeFileSync(descriptor, String(process.pid) + "\n");
    publish(packageDir, plan);
  } finally {
    closeSync(descriptor);
    unlinkSync(lock);
  }
}

export function runInstaller(argv) {
  try {
    const options = parse(argv);
    if (options.help) {
      console.log(
        "用法：node install.mjs --host <" +
          hostIds.join("|") +
          "> [--host-dir <目录>] [--bundle-only] [--dry-run]"
      );
      return;
    }
    if (!options.host)
      throw new Error("请使用 --host 选择宿主。支持：" + hostIds.join("、"));
    const packageDir = resolve(
      process.env.AGENT_HARNESS_HOME || join(homedir(), ".agent-harness")
    );
    const plan = hostPlan(options.host, packageDir, options);
    for (const item of plan.outputs) {
      const path = relative(physicalPath(packageDir), physicalPath(item.path));
      if (!isAbsolute(path) && path !== ".." && !path.startsWith(".." + sep)) {
        throw new Error("宿主配置不能位于共享包目录内：" + item.path);
      }
    }
    if (options.dryRun) {
      console.log(
        JSON.stringify(
          {
            host: plan.id,
            packageDir,
            files: plan.outputs.map((item) => ({
              path: item.path,
              kind: item.kind,
            })),
            nativeReviewer: plan.hasNativeReviewer,
          },
          null,
          2
        )
      );
      return;
    }
    install(packageDir, plan);
    console.log("研发 Agent 共享包：" + packageDir);
    console.log(plan.title + " 适配已安装：" + plan.root);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runInstaller(process.argv.slice(2));
}
