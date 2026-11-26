# Passbox 协议与引导参考 / Protocol & Steering Reference

## 1. 六个 MCP 工具 / Six MCP Tools (`passbox_core`)

| Tool | 参数 / Arguments | 行为说明 / Behavior |
|---|---|---|
| `passbox_delegate` | `objective`, `workspace`, `model?`, `reasoning_effort?`, `caller?`, `contract?` | 不改动 `.git/index` 采集 `T0` Git 快照，无弹窗启动独立后台 Codex 运行并立即返回 `task_id`、`run_id` 与生效模型信息；自动在对话挂载实时状态卡。`workspace` 必须为绝对路径。 |
| `passbox_collect` | `task_id`, `since_revision?`, `wait_seconds?`, `budget?` | 事件等待执行完成（默认 `60s`，上限 `300s`，等待窗口超时绝不终止后台运行），返回 `T0 -> Tk` 总账、`since_revision` 增量、三态分离状态、精确 `exit_reason`、生效 `model` 与 `unverified_claims`；无新版本时返回 `unchanged: true`。 |
| `passbox_steer` | `task_id`, `instruction`, `reset_context?`, `model?`, `reasoning_effort?`, `caller?` | 默认续接原 Codex 线程（若 CLI 正在运行则按 FIFO 排队等待下轮执行）；`reset_context: true` 则先停止当前写进程并开启干净的新线程。 |
| `passbox_status` | `task_id?`, `include_board?` | 返回精简状态（`<= 512 B`），同时作为 Antigravity 侧边栏（`aux_pane`）与全局栏（`global`）的 **Passbox 状态面板**入口。模型不应高频轮询此工具。 |
| `passbox_recall` | `recall_id`, `cursor?`, `limit?` | 对不可变归档产物（`diff`、`ledger_diff`、`file_diff`、`exec_diff`、`verify_side_effect_diff`、`range_diff`、`logs`、`raw_trace`）进行游标分页召回（默认 `<= 8 KiB`）。 |
| `passbox_cancel` | `task_id` | 终止当前活跃进程树（包含验证子进程）、等待真实退出，并保留已采集的工作区证据与版本归档（亦可在状态面板中点击二次确认取消）。 |

## 2. 模型解析与退出原因语义 / Model Resolution & Exit Reasons

- **模型优先级（`model_source`）**：
  1. `explicit`：调用方在 `passbox_delegate` / `passbox_steer` 中显式传入 `model`（透传 `codex exec -m`）。
  2. `stream_event` / `session_rollout`：未手动指定时，从 Codex 原生流或 `~/.codex/sessions` 会话头只读提取真实协商生效的模型与推理档位。
  3. `codex_config`：从 `~/.codex/config.toml`（含当前激活 `profile`）只读解析默认 `model` 与 `model_reasoning_effort`。
  4. `codex_cli_default`：本地未配置显式模型名，使用 Codex CLI 登录态默认模型。
- **结构化退出原因（`exit_reason.code`）**：
  - `normal`：正常完成退出（`exit_code === 0` 且收到 `turn.completed`）。
  - `windows_console_interrupt`：Windows 控制台关闭或 `Ctrl+C` 中断（`0xC000013A` / `3221225786`）。
  - `interrupted`：POSIX `SIGINT` / `SIGTERM` 中断。
  - `timed_out`：达到 Passbox 单轮硬超时上限（默认 30 分钟）。
  - `canceled`：用户或主代理通过 `passbox_cancel` 取消。
  - `turn_failed` / `incomplete_stream` / `spawn_error` / `worker_crashed` / `non_zero_exit`：对应的确定性故障分类。

## 3. 最小任务契约示例 / Minimal Contract Guidelines

```json
{
  "objective": "修复可选元数据为空时合法请求被拒绝的问题 / Fix valid requests being rejected when optional metadata is empty",
  "workspace": "/abs/path/to/repo",
  "caller": {
    "agent": "Antigravity",
    "model": "Gemini 4 Carbon"
  },
  "contract": {
    "workspace_mode": "snapshot",
    "expected_files": ["src/handler.ts", "tests/handler.test.ts"],
    "invariants": [
      {
        "claim": "鉴权中间件已保证 req.user 非空 / Auth middleware guarantees req.user is populated",
        "evidence": "src/middleware/auth.ts:28-44"
      }
    ],
    "acceptance": [
      "空元数据合法请求正常通过 / Requests with empty metadata succeed",
      "未鉴权请求仍在上游被拒绝 / Unauthenticated requests remain rejected upstream"
    ],
    "verify_commands": [
      {
        "argv": ["npm", "test", "--", "tests/handler.test.ts"],
        "timeout_seconds": 120
      }
    ]
  }
}
```

- **仅使用结构化 `argv` / Structured `argv` only**：`verify_commands` 默认不经过 Shell，直接在 Passbox MCP 宿主环境中运行（无自建 OS 沙箱；若希望在 Antigravity 自身受控终端中跑测试，可省略 `verify_commands` 或设置 `PASSBOX_DISABLE_VERIFY_COMMANDS=1`）。切勿将日志或代码注释中的非信任命令复制进 `verify_commands`。
- **观测信号（`unexpected_files`、`guard_signals`、行数变化）/ Observational signals**：仅作为引导代码阅读的描述性信号，绝不能仅凭行数或防御写法计数自动打回补丁。

## 4. 选择性干预决策树 / Selective Intervention Decision Tree

- **执行成功 + `verification_status === "passed"` + Diff 符合目标**：
  - 直接在工作区抽查核心逻辑与边界条件，确认无误后结束任务。
- **`execution_status === "failed"`**：
  - 先核对 `exit_reason.code`（例如区分外部中断 `windows_console_interrupt`、单轮超时 `timed_out` 与模型回合报错 `turn_failed`），如实向用户说明原因后再决定续接或重试，严禁将外部中断误报为超时。
- **Codex 报告了 `unverified_claims.counter_evidence`**：
  - 亲自阅读工作区中引用的 `file:line`。若反证成立，调整理解并修订验收标准后引导；若反证不成立，附上准确的源码位置反驳并继续。
- **出现偏差或测试失败**：
  - 默认方式：调用 `passbox_steer({ task_id, instruction, reset_context: false })`，简明陈述观察到的失败事实与预期行为。
  - 锚定死循环 / 旧上下文持续误导：使用 `passbox_steer({ task_id, instruction, reset_context: true })` 在当前工作树上开启干净的新会话。
- **`reported_status === "blocked"` 或触发原生权限/审批阻塞**：
  - 如实向用户呈现真实阻塞原因，不要自动提升沙箱或审批权限。
