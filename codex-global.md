<!-- business-agent:start -->

## 研发 Agent

- 在 Codex 中处理仓库分析、实现、审查或验收时，读取用户级 `${AGENT_HARNESS_HOME:-$HOME/.agent-harness}/core.md`，由当前主 Agent 按该流程工作。明确说「用研发 Agent」时也使用同一入口。纯问答按会话处理。
- 以当前任务仓库为项目根目录，按核心说明装配命中的共用能力和可选项目适配器。宿主和项目规则继续生效，项目凭据、连接器配置和真实环境取自目标项目的授权来源。
<!-- business-agent:end -->
