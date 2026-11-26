# Passbox

[中文说明](#passbox-中文说明) | [English](#passbox-english)

---

## Passbox 中文说明

**Passbox** 是面向 Google Antigravity 的本地跨 Harness 编排插件，让 **Gemini**（Antigravity 主会话）与 **OpenAI Codex**（原生 Codex CLI）通过 **上下文隔离**、**确定性 Git 证据采集** 与 **按需选择性引导** 高效协作。

### 核心特性与架构不变量

- **完整保留原生 Harness**：直接在目标仓库调用原生的 `codex exec` 与 `codex exec resume`，不替换 `CODEX_HOME`、`HOME`、`~/.codex/config.toml`、`AGENTS.md`、Skills、Plugins、MCP 服务或原生沙箱/审批策略；直接使用本机官方登录与订阅，不做 OAuth 转发或静默付费 API 回退。
- **显式调用（`/passbox`）**：设置 `disable-model-invocation: true`，首版不安装全局 `rules/` 或拦截 `hooks.json`，仅在用户显式输入 `/passbox` 时触发，与 **Cospan** 等其他插件和平共存。
- **无损 Git 快照模式（Snapshot Mode）**：使用隔离的临时 `GIT_INDEX_FILE`（`git add -A` + `git write-tree`）采集 `T0` 基线、执行后快照与验证后快照，绝不修改用户真实的 `.git/index` 或未提交改动；同时支持隔离的 `workspace_mode: "worktree"`，且同一写工作区互斥防并发踩踏。
- **证据防火墙（三态严格分离）**：
  - `execution_status`：进程与原生 NDJSON 流决定的真实运行状态（`running | succeeded | failed | canceled | timed_out`）。
  - `reported_status` 与 `unverified_claims`：Codex 的结构化 JSON 自述（`completed | partial | blocked`、`blockers`、`counter_evidence`），显式标记 `verified: false`；默认不转发冗长的自然语言过程叙事。
  - `verification_status` 与 `observations`：独立 `verify_commands` 结果与确定性 `T0 -> Tk` 总账 + `since_revision -> Tk` 增量 Diff，区分 Codex 修改、验证命令副作用（含验证还原前的 `exec_diff` 保底归档）及外部漂移。
- **严格字节预算与不可变召回**：所有响应与报错均按真实 MCP JSON-RPC 线级字节数受控（`status <= 512 B`、摘要 `<= 2 KiB`、预览 `<= 12 KiB / 300 行`、`recall` 默认 `<= 8 KiB`、单次硬上限 `<= 32 KiB`），完整补丁、日志与脱敏轨迹持久化在 `PLUGIN_DATA`。
- **双行多智能体实时状态面板（MCP App，中文/EN 可切换）**：内置 `ui://passbox/board.html` 状态台（支持对话内嵌自动展开、右侧边栏 `+ -> Passbox` 及左侧全局栏打开）：
  - **第一行（主代理编排侧）**：显示主代理及传入模型名、当前编排状态（等待收集 / 后台执行中 / 已排队引导 / 已完成收集）与最近编排动作。
  - **第二行（Codex 执行器侧）**：显示实际生效模型与推理档位（区分手动指定、会话 rollout 实测、`config.toml` 与 CLI 默认）、实时阶段步进器、跳动计时器、最新原生事件与精确退出原因（如将 `0xC000013A` 直接显示为「Windows 控制台中断」），并在展开详情中并列呈现各修订的**执行状态 · 模型自报 · 独立验证**三态结论。

### 如何开始使用 `/passbox`

在 Antigravity 对话框中显式输入 `/passbox` 加上你的任务即可（任务启动后会自动挂载内嵌实时状态卡，也可随时在右侧边栏 `+` 菜单选择 **Passbox** 打开完整多任务状态面板，默认中文并支持一键切换中英文）：

```text
/passbox 请让 Codex 修复当前仓库中空输入导致鉴权跳过的 bug，并补充单元测试后运行 npm test 验证。
```

**典型交互流程（由 Gemini 自动编排，你只需确认与验收）：**
1. Gemini 先独立阅读相关入口代码并构建最小契约，调用 `passbox_delegate` 交给 Codex 后台运行。
2. Gemini 调用 `passbox_collect` 事件等待结果，拿到版本化文件统计、增量 Diff 预览、独立验证结论与待核验声明。
3. 如某个大文件 Diff 或长日志被截断，Gemini 自动按需通过 `passbox_recall` 分页查看；若发现偏差，通过 `passbox_steer` 续接或重置上下文修正；若要提前中止，使用 `passbox_cancel`。

### 六个 MCP 工具（`passbox_core`）

| 工具名 | 参数 | 用途 |
|---|---|---|
| `passbox_delegate` | `objective`, `workspace`, `contract?` | 采集 `T0` 快照并启动异步 Codex 任务，立即返回 `task_id` 与 `run_id`（`workspace` 须为绝对路径）。 |
| `passbox_collect` | `task_id`, `since_revision?`, `wait_seconds?`, `budget?` | 事件等待（默认 `60s`）并返回 `T0 -> Tk` 总账、增量 Diff、验证结果与未核验声明；无新版本返回 `unchanged: true`。 |
| `passbox_steer` | `task_id`, `instruction`, `reset_context?` | 续接当前 Codex 线程（运行中按 FIFO 排队）或停止旧运行后开启新线程（`reset_context: true`）。 |
| `passbox_status` | `task_id` | 返回精简（`<= 512 B`）的任务与进程状态。 |
| `passbox_recall` | `recall_id`, `cursor?`, `limit?` | 游标分页读取不可变归档产物（`diff`、`ledger_diff`、`file_diff`、`exec_diff`、`verify_side_effect_diff`、`range_diff`、`logs`、`raw_trace`）。 |
| `passbox_cancel` | `task_id` | 终止活跃 Codex 或验证子进程树，确认退出并保留已采集的证据。 |

### 构建、测试与安装

```bash
# 安装开发依赖、构建 dist 与独立插件包、运行全部自动化测试
npm install
npm run build
npm test

# 校验插件清单与独立产物包
npm run validate:plugin

# 安装到本机 Antigravity（~/.gemini/config/plugins/passbox）
agy plugin install ./dist/plugin-bundle
agy plugin list --json
```

---

## Passbox English

**Passbox** is a native Google Antigravity cross-harness orchestration plugin enabling high-signal collaboration between **Gemini** (in Antigravity) and **OpenAI Codex** (in its native CLI harness) through **context isolation**, **deterministic Git evidence collection**, and **selective steering**.

### Key Capabilities & Invariants

- **Native Harness Preservation**: Invokes native `codex exec` and `codex exec resume` directly in the target workspace without replacing `CODEX_HOME`, `HOME`, `~/.codex/config.toml`, `AGENTS.md`, skills, plugins, MCP servers, or native sandbox/approval policies. Uses existing local CLI login/subscription without OAuth forwarding or silent paid API fallbacks.
- **Explicit Invocation (`/passbox`)**: Ships with `disable-model-invocation: true` and zero global `rules/` or intercepting `hooks.json`, so normal Antigravity sessions and sibling plugins (including **Cospan**) operate undisturbed unless `/passbox` is invoked.
- **Non-Destructive Git Snapshot Mode**: Captures `T0` baseline, post-execution, and post-verification tree snapshots via an isolated temporary `GIT_INDEX_FILE` (`git add -A` + `git write-tree`), never mutating the user's real `.git/index` or uncommitted edits. Also supports isolated `workspace_mode: "worktree"` and prevents concurrent snapshot writers on the same workspace.
- **Evidence Firewall (Three-Way Status Separation)**:
  - `execution_status`: process and native NDJSON stream state (`running | succeeded | failed | canceled | timed_out`).
  - `reported_status` & `unverified_claims`: Codex's structured JSON report (`completed | partial | blocked`, `blockers`, `counter_evidence`), explicitly marked `verified: false`. Natural-language chat narrative is never forwarded by default.
  - `verification_status` & `observations`: independent `verify_commands` outcome and deterministic `T0 -> Tk` ledger + `since_revision -> Tk` incremental diffs, separating Codex edits (including pre-verify `exec_diff` preservation) from test side-effects and external workspace drift.
- **Strict Wire-Exact Byte Budgets & Immutable Recall**: Enforces hard caps across final JSON-RPC responses and errors (`<= 512 B` `status`, `<= 2 KiB` summary, `<= 12 KiB / 300 lines` preview, `<= 8 KiB` cursor-paginated `recall`, `<= 32 KiB` hard ceiling), storing full diffs, logs, and redacted traces under `PLUGIN_DATA`.

### Six MCP Tools (`passbox_core`)

| Tool | Parameters | Purpose |
|---|---|---|
| `passbox_delegate` | `objective`, `workspace`, `contract?` | Captures `T0` snapshot and launches an asynchronous detached Codex run; returns `task_id` and `run_id` (`workspace` must be an absolute path). |
| `passbox_collect` | `task_id`, `since_revision?`, `wait_seconds?`, `budget?` | Event-waits up to `wait_seconds` (default `60s`) and returns cumulative ledger, incremental delta, verification results, and unverified claims (`unchanged: true` when up to date). |
| `passbox_steer` | `task_id`, `instruction`, `reset_context?` | Resumes the existing Codex thread (`reset_context: false`, FIFO-queued if active in CLI mode), or starts a fresh Codex thread (`reset_context: true`) after stopping any active writer. |
| `passbox_status` | `task_id` | Returns a compact (`<= 512 B`) process and revision status summary. |
| `passbox_recall` | `recall_id`, `cursor?`, `limit?` | Cursor-paginates immutable archived `diff`, `ledger_diff`, `file_diff`, `exec_diff`, `verify_side_effect_diff`, `range_diff`, `logs`, or `raw_trace`. |
| `passbox_cancel` | `task_id` | Terminates the active Codex or verification process tree, confirms exit, and preserves collected workspace evidence. |

### Build, Test & Install

#### Prerequisites

- Node.js `>= 20`
- Git `>= 2.38`
- Antigravity CLI (`agy`) and OpenAI Codex CLI (`codex`) authenticated locally

```bash
npm install
npm run build
npm test

# Validate repository manifest and standalone clean bundle
npm run validate:plugin

# Install into Antigravity (~/.gemini/config/plugins/passbox)
agy plugin install ./dist/plugin-bundle
agy plugin list --json
```

Once installed, invoke `/passbox` in Antigravity chat to delegate cohesive engineering tasks to Codex with deterministic evidence verification.

### Verified Compatibility Notes (Baseline vs. Real Interfaces)

1. **Namespace Normalization (`passbox`)**: Normalized leftover draft `contract-flow` identifiers in `ARCHITECTURE.md` v0.3 to `passbox` (`plugin.json` `name: "passbox"`, skill `/passbox`, MCP server `passbox_core`, tools `passbox_delegate`..`passbox_cancel`), preventing any collision with Cospan (`cospan`, `cospan-*`) or built-in plugins.
2. **`codex exec` vs. `codex exec resume` Flag Asymmetry (`codex-cli 0.172.0`)**: Verified that `codex exec resume` supports `--json`, `--output-schema`, and `-o`/`--output-last-message`, but rejects `-C`/`--cd`, `-s`/`--sandbox`, and `-a`/`--ask-for-approval`. M3 sets `cwd` directly on the spawned child process for both initial and resumed runs.
3. **OpenAI Strict JSON Schema (`--output-schema`)**: All object schemas require `additionalProperties: false` and every property key listed in `required` (`evidence` typed as `["string", "null"]`).
4. **Antigravity Plugin Environment (`agy 1.5.17`)**: Antigravity automatically exports `PLUGIN_ROOT` and `PLUGIN_DATA` to plugin MCP servers; `mcp_config.json` avoids duplicating them in `env` and configures `timeoutSeconds: 600` to accommodate event-driven `passbox_collect` waits (`<= 300s`).
5. **Windows CLI Shims & Line Endings**: M3 unwraps Node `.cmd` shims (including `mise` and `npm` installs on Windows) directly to `node.exe` + script path, and Worktree Mode uses `-c core.autocrlf=false` during baseline tree materialization so LF files are preserved byte-for-byte on Windows.
