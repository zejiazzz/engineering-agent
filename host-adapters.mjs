import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const skillPath = "skills/engineering-agent/SKILL.md";
const skillMarker = "<!-- business-agent-managed: engineering-agent -->";
const reviewDescription =
  "独立只读审查变更，核对项目契约、回归风险和验证证据。";

const adapters = {
  codex: {
    title: "Codex",
    root: () => process.env.CODEX_HOME || join(homedir(), ".codex"),
    instructions: "AGENTS.md",
    reviewer: "agents/code-reviewer.toml",
  },
  "claude-code": {
    title: "Claude Code",
    root: () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
    instructions: "CLAUDE.md",
    fallbackSkill: skillPath,
    reviewer: "agents/code-reviewer.md",
  },
  cursor: {
    title: "Cursor",
    root: () => join(homedir(), ".cursor"),
    skill: skillPath,
    reviewer: "agents/code-reviewer.md",
  },
  workbuddy: {
    title: "WorkBuddy",
    root: () => join(homedir(), ".workbuddy"),
    skill: skillPath,
  },
  "deepseek-harness": {
    title: "DeepSeek Harness",
    root: () => process.env.DSH_HOME || join(homedir(), ".dsh"),
    instructions: "AGENTS.md",
    skill: skillPath,
  },
  opencode: {
    title: "OpenCode",
    root: () =>
      join(
        process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
        "opencode"
      ),
    instructions: "AGENTS.md",
    reviewer: "agents/code-reviewer.md",
  },
};

export const hostIds = Object.keys(adapters);

function reviewerPrompt(packageDir) {
  return [
    "你是独立的只读代码审查角色。只执行只读检查，禁止修改文件、暂存、提交、安装依赖或触发外部业务操作。",
    "读取共用审查流程 " +
      JSON.stringify(join(packageDir, "plugins/code-review.md")) +
      "，按其中的审查顺序和结论工作。",
    "遵守目标项目的指令和 .agent-harness.json。前端改动按需装配前端规范及项目覆盖。审查证据和权限以当前宿主实际能力为准。",
  ].join("\n");
}

function nativeReviewer(host, packageDir) {
  const prompt = reviewerPrompt(packageDir);
  const marker = "business-agent-managed: code-reviewer";
  if (host === "codex") {
    return (
      "# " +
      marker +
      '\nname = "code-reviewer"\ndescription = ' +
      JSON.stringify(reviewDescription) +
      "\ndeveloper_instructions = " +
      JSON.stringify(prompt) +
      "\n"
    );
  }
  const fields = ["description: " + JSON.stringify(reviewDescription)];
  if (host !== "opencode") fields.unshift("name: code-reviewer");
  if (host === "claude-code")
    fields.push("tools: Read, Glob, Grep, Bash", "model: inherit");
  if (host === "cursor") fields.push("model: inherit", "readonly: true");
  if (host === "opencode") {
    fields.push(
      "mode: subagent",
      "permissions:",
      "  - action: edit",
      '    resource: "*"',
      "    effect: deny"
    );
  }
  return (
    "---\n" +
    fields.join("\n") +
    "\n---\n\n<!-- " +
    marker +
    " -->\n\n" +
    prompt +
    "\n"
  );
}

function instructions(adapter, packageDir) {
  const review = adapter.reviewer
    ? "宿主已登记 code-reviewer 角色。需要独立审查时按实际授权调用。"
    : "需要独立审查时调用当前宿主实际提供的独立子任务，并传入共用审查流程。缺少独立能力时按项目门禁报告待验。";
  return (
    [
      "## 研发 Agent",
      "",
      "处理当前仓库的需求分析、实现、验证、代码审查或 Git 交付时，先读取 " +
        JSON.stringify(join(packageDir, "core.md")) +
        "。用户明确说「用研发 Agent」时进入同一流程。纯问答沿用当前会话。",
      "在目标仓库读取可选的 .agent-harness.json，并按任务装配共用能力和项目适配器。" +
        review,
      "按 acceptance 入口设计和执行用例、真实验收、续验及验收排障。",
      "实际命令、模型、连接器及审批由当前宿主提供，并按项目约定和用户授权使用。",
    ].join("\n") + "\n"
  );
}

// 只更新安装器曾通过 --bundle-only 部署的后备 Skill。
function hasManagedSkill(path) {
  try {
    return lstatSync(path).isFile() &&
      readFileSync(path, "utf8").split(/\r?\n/).includes(skillMarker);
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code)) return false;
    throw error;
  }
}

/** 各宿主仅部署入口和角色。任务、模型与授权由宿主执行。 */
export function hostPlan(id, packageDir, options) {
  if (!Object.hasOwn(adapters, id)) throw new Error("未知宿主：" + id);
  const adapter = adapters[id];
  const root = resolve(options.hostDir || adapter.root());
  const body = instructions(adapter, packageDir);
  const outputs = [];
  if (adapter.instructions && !options.bundleOnly) {
    outputs.push({
      path: join(root, adapter.instructions),
      kind: "instructions",
      content: body,
    });
  }
  let skill = adapter.skill;
  if (adapter.fallbackSkill &&
      (options.bundleOnly || hasManagedSkill(join(root, adapter.fallbackSkill)))) {
    skill = adapter.fallbackSkill;
  }
  if (skill) {
    const header = [
      "---",
      "name: engineering-agent",
      "description: 使用组织的研发 Agent 流程处理需求分析、代码实现、用例与真实验收、续验、验收排障、审查、飞书缺陷和 Git 交付。用户说「用研发 Agent」时调用。",
      "---",
      "",
      skillMarker,
      "",
    ].join("\n");
    outputs.push({
      path: join(root, skill),
      kind: "managed",
      marker: "business-agent-managed: engineering-agent",
      content: header + "\n" + body,
    });
  }
  if (adapter.reviewer) {
    outputs.push({
      path: join(root, adapter.reviewer),
      kind: "managed",
      marker: "business-agent-managed: code-reviewer",
      content: nativeReviewer(id, packageDir),
    });
  }
  return {
    id,
    title: adapter.title,
    root,
    outputs,
    hasNativeReviewer: Boolean(adapter.reviewer),
  };
}
