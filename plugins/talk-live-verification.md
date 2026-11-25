# Talk 真实验收

适用于含对话、异步生成或可续查任务的产品。从项目适配器或已有项目入口和文档核对环境、用例、任务定位、终态、产出标准、适用计量及验证要求。先明确全量、定向、续验或只读排查范围，核对当前代码和可复用的证据。写入、实际计费、上传和重试按任务授权执行。真实入口或必要测试条件无法确定时，说明受影响的场景并继续可以完成的排查。

## 从提交到终态

1. 通过真实产品入口操作，记录场景、实际选择、输入标记、当前报价或免费条件。由单一操作者持有真实会话。异步任务提交前登记开始，提交后登记可追溯的会话与任务 ID。提交结果未知时按原标记到历史、任务、成品或账单对账。只有证实未受理且具备重试依据后才能再发。
2. 跟踪同一个任务，记录受理、在途、成功、失败、取消及待确认状态。测试窗口结束时为在途任务保留可恢复定位。正常对话按场景验证用户可见输出或后续行为。生成场景需要成功终态、可用成品、内容与输入一致及适用的计费或退款证据。失败、取消或免费场景按项目约定的实际结果判定。
3. 排查沿输入、表单、受理记录、服务结果、展示或计量追到第一个偏离。修复在范围内且有证据支撑的问题。变更后复核受影响场景，保留未受影响的有效证据。能在原任务补齐作品或账单时继续查看原任务。报告通过、失败、待验、可续跑的任务 ID 和代码基线。

## 可复用账本

有现成账本的项目可以保留自己的工具。需要共享账本时，让项目命令调用 [talk/ledger.cjs](talk/ledger.cjs)。它负责会话及任务对账、唯一提交标记、基线变化、历史尝试和通过判定。调用方提供项目本地忽略的账本目录、用例配置、代码指纹函数及可选的故障来源和报价验证规则。浏览器操作和现场取证由项目适配器负责。

```js
const { homedir } = require("node:os");
const { resolve } = require("node:path");
const agentHome =
  process.env.AGENT_HARNESS_HOME || resolve(homedir(), ".agent-harness");
const { runTalkLedger } = require(resolve(
  agentHome,
  "plugins/talk/ledger.cjs"
));

runTalkLedger(process.argv.slice(2), {
  stateDir,
  currentCode,
  definitions,
});
```

`definitions` 至少提供一个用例。每项包括唯一 `id`、证据 `mode`、非空且互不重复的 `evidence` 字段列表及可选布尔值 `task`（为 `true` 时要求异步成功任务）。ID 使用小写英文字母、数字和短横线，以字母或数字开头，`full` 留作全量参数。`currentCode` 返回非空字符串指纹，覆盖相关实现与配置。默认报价须为非负有限数，免费填 `0`。需要特殊报价规则时传 `isValidQuote` 和可选 `quoteError`。默认 `failureSources` 为 `product`、`service`、`environment`、`unknown`。

项目命令支持 `list`、`init <运行 ID> [full|逗号分隔用例 ID]`、`event <运行 ID> <用例 ID> <事件> <JSON>`、`revise <运行 ID> <JSON>`、`report <运行 ID>`。`report` 只有适用范围全部通过且代码指纹匹配才退出 `0`，未通过为 `1`，操作错误为 `2`。

| 事件            | JSON 字段和时机                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| `begin`         | `marker`、`quote`。提交异步任务前登记当前可观察报价和本次唯一标记。                                                |
| `accepted`      | `chat`、`task`、`evidence`。提交后登记真实会话和任务定位。                                                         |
| `adopt`         | `begin` 和 `accepted` 的全部字段。无尝试记录且已从产品确认任务身份时续验。                                         |
| `terminal`      | `outcome`、`evidence`。已受理任务使用 `succeeded`、`failed` 或 `canceled`。已确认未受理的提交使用 `not-accepted`。 |
| `pass`          | `mode`、`evidence` 对象。匹配用例配置的证据模式并为每个字段提供简短文本。异步任务还须具备当前有效的成功终态。      |
| `fail`、`block` | `source`、`evidence`。记录失败或阻塞依据。                                                                         |
| `reopen`        | `evidence`。失败或阻塞条件改变后按新证据重开，有未终结的提交时先完成对账。                                         |

代码变更后，`revise` 传 `affected` 用例 ID 数组及 `evidence`，按实际影响决定证据失效范围。已有任务身份和历史尝试会保留，可继续对账。
