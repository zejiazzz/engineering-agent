# 研发 Agent · Engineering Agent

在不同 AI 编程工具中复用同一套研发流程，从需求分析、方案设计到实现、验证和代码审查。每台机器装一份共享包，各宿主加载对应入口。已有项目可直接使用，按需用 `.agent-harness.json` 增加项目约定或覆盖插件。模型和工具使用宿主已有配置。

## 快速开始

### 让 AI 安装

把下面这句发给能访问本仓库并执行终端命令的 AI。

```text
请读取 https://raw.githubusercontent.com/zejiazzz/engineering-agent/main/INSTALL.md，自行识别当前宿主，先按指南执行普通预览和安装，仅在安装器提示时使用 --bundle-only，最后验证实际宿主入口。
```

[安装指南](INSTALL.md)

### 手动安装

从发布仓库检出要安装的版本，在源码根目录运行以下命令。安装器和装配工具使用 Node.js 16.9+，无 npm 依赖。

```bash
node install.mjs --host codex
node install.mjs --host claude-code
node install.mjs --host cursor
node install.mjs --host workbuddy
node install.mjs --host deepseek-harness
node install.mjs --host opencode
```

按需要安装相应宿主。所有宿主共用 `~/.agent-harness/` 的运行包，项目目录无需重新复制规则。用 `--dry-run` 预览写入路径。宿主使用自定义配置目录时传 `--host-dir <目录>`。共享包路径可由环境变量 `AGENT_HARNESS_HOME` 指定，调用共享账本等命令时使用同一变量。

| 宿主             | 入口                                                   | 独立审查                                      |
| ---------------- | ------------------------------------------------------ | --------------------------------------------- |
| Codex            | 用户级 `AGENTS.md`                                     | `agents/code-reviewer.toml`                   |
| Claude Code      | 用户级 `CLAUDE.md`                                     | `agents/code-reviewer.md`                     |
| Cursor           | 全局 `engineering-agent` Skill，根据任务匹配或显式调用 | 用户级 Markdown 子角色，设置 `readonly: true` |
| WorkBuddy        | 全局 `engineering-agent` Skill，根据任务匹配或显式调用 | 使用当前版本和权限下可用的独立子任务          |
| DeepSeek Harness | `DSH_HOME` 的 `AGENTS.md` 和全局 Skill                 | 使用当前 profile 中启用的子代理能力           |
| OpenCode V2      | 用户级 `AGENTS.md`                                     | 用户级 Markdown 子角色及编辑权限配置          |

安装后在目标项目开新会话。可直接提出研发任务，也可输入「用研发 Agent 实现并验证这个需求」。Cursor、WorkBuddy 或通过 Skill 安装的 Claude Code 也可以在技能入口选择 `engineering-agent`。Cursor 编辑器如需每次都加载，可在 User Rules 添加指向共享包 `core.md` 的规则。DeepSeek Harness 如当前 profile 不加载工作区指令，可通过已登记的 Skill 进入。

宿主缺少当前项目要求的独立审查、浏览器、MCP 或其他能力时，根据实际覆盖完成已具备的部分并报告待验。各宿主使用其自身的模型配置、已有安装和权限管理。

### 已有安装升级

- 旧命令 `node install-codex.mjs` 继续指向 Codex 适配器。升级后的共用文件安装到 `~/.agent-harness/`。
- 全局规则由其他工具生成时，用 `--bundle-only` 更新共用包及 Skill、审查角色，再把入口登记在规则生成源。使用 `ai-rules` 维护全局入口时，用新版 [codex-global.md](codex-global.md) 更新生成片段后同步。旧的 `~/.codex/agent-harness` 保留为迁移前版本，升级后各入口使用共用目录。
- Claude Code 的全局指令是符号链接或由其他工具维护时，`--bundle-only` 部署全局 Skill 和子角色。其他宿主若需从外部规则生成源启用，登记「处理仓库任务时，先读取研发 Agent 共用包的 `core.md`」。
- 安装器保留其他用户指令。已有未托管的同名 Skill 或角色时停止安装并标出路径。回退需用前一发布版本，并恢复与版本匹配的宿主入口和项目适配器。
- 安装中断时，检查包目录父级 `.engineering-agent-install.lock` 的 PID。进程已退出且共享包缺失时，可从该次 `.engineering-agent-bundle-*/previous` 恢复旧包，再清理过期锁并重新安装相应宿主。

## 项目接入

项目默认使用共享核心和宿主已发现的仓库规则。需要覆写某个插件时，在项目根目录配置项目约定或适配器。以下以飞书缺陷为例。

```json
{
  "schemaVersion": 1,
  "profile": "docs/project-agent.md",
  "plugins": [
    {
      "id": "feishu-defects",
      "adapter": "docs/feishu-adapter.md"
    }
  ]
}
```

`profile` 和 `plugins` 均可省略。与 [默认清单](defaults.json) 中 ID 相同的插件可以提供项目 `when`、`entry` 或 `adapter`。项目专用插件提供 `when` 和 `entry`。本地入口使用项目内相对路径。设 `enabled: false` 关闭本项目的共用插件。

| 共用能力      | 入口                                                |
| ------------- | --------------------------------------------------- |
| 飞书缺陷      | [取证、修复与同步](plugins/feishu-defects.md)       |
| Talk 真实验收 | [验收和共用账本](plugins/talk-live-verification.md) |
| Git 交付      | [auto-commit](plugins/auto-commit.md)               |
| 独立代码审查  | [code-review](plugins/code-review.md)               |
| Web 前端      | [目录和设计规范](plugins/frontend-standards.md)     |
| 工程诊断      | [架构历史、交接成本、PR 耗时与缺陷复盘](plugins/engineering-diagnostics.md) |

在目标项目根目录校验文件并预览装配。

```bash
node "${AGENT_HARNESS_HOME:-$HOME/.agent-harness}/compose.mjs" code-review frontend-standards
```

命令按项目清单和共用清单返回绝对路径顺序。任务是否命中由当前宿主里的主 Agent 判断。

## 开发与贡献

使用 Node.js 22+ 运行 `npm test`。回归测试在临时目录验证各宿主的生成文件、全局配置保留和项目装配，不需要宿主账号。提交变更和准备发布见[贡献指南](CONTRIBUTING.md)。

## 宿主契约来源

- [Codex 用户级指令](https://developers.openai.com/codex/guides/agents-md) · [自定义角色](https://developers.openai.com/codex/subagents)
- [Claude Code 指令](https://code.claude.com/docs/en/memory) · [自定义子角色](https://code.claude.com/docs/en/sub-agents)
- [Cursor 技能](https://cursor.com/docs/skills) · [用户规则](https://cursor.com/docs/rules) · [子角色](https://cursor.com/docs/subagents)
- [WorkBuddy 技能管理](https://cloud.tencent.com/document/product/1831/134432) · [全局 Skill](https://developer.cloud.tencent.com/techpedia/2610/20530)
- [DeepSeek Harness 指令](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/context/agent-instructions/README.md) · [Skills](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/skills.md) · [子代理](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/tool-subagent/README.md)
- [OpenCode 指令](https://opencode.ai/docs/instructions/) · [自定义 Agent](https://opencode.ai/docs/agents/)

## 许可证

[MIT License](LICENSE)
