import { DEFAULT_BUDGETS, EvidenceFirewall } from '../firewall/index.js';
import { ArchiveStore } from '../observability/index.js';
import { SessionManager } from '../session/index.js';
import { PASSBOX_BOARD_RESOURCE_URI } from './board-ui.js';
const CALLER_SCHEMA_PROPERTY = {
    type: 'object',
    additionalProperties: false,
    description: '可选主会话编排侧元数据（用于状态面板展示主代理模型与会话标识）。Optional host coordinator metadata for the Passbox status board.',
    properties: {
        agent: { type: 'string' },
        model: { type: 'string' },
        session_id: { type: 'string' },
    },
};
export const PASSBOX_MCP_TOOLS = [
    {
        name: 'passbox_delegate',
        title: 'Passbox Delegate',
        description: '在指定 Git 仓库启动新的 Codex 委托任务（上下文隔离 + 无损 T0 Git 快照），立即返回 task_id 与 run_id。' +
            'Launch a new Codex delegation task in the specified Git workspace with context isolation ' +
            'and a non-destructive T0 Git tree snapshot. Returns immediately with task_id and run_id.',
        _meta: {
            ui: {
                resourceUri: PASSBOX_BOARD_RESOURCE_URI,
                visibility: ['model', 'app'],
            },
        },
        inputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['objective', 'workspace'],
            properties: {
                objective: {
                    type: 'string',
                    description: '委托给 Codex 的完整业务目标（建议与用户语言一致）。Cohesive business objective to delegate to Codex.',
                },
                workspace: {
                    type: 'string',
                    description: '目标 Git 仓库的绝对路径。Absolute path to the target Git repository workspace.',
                },
                model: {
                    type: 'string',
                    description: '可选手动指定的 Codex 模型名称（如 "gpt-5.4"）；省略时继承本机 ~/.codex/config.toml 或 Codex CLI 默认模型。' +
                        'Optional explicit Codex model override; inherits ~/.codex/config.toml or Codex CLI default when omitted.',
                },
                reasoning_effort: {
                    type: 'string',
                    enum: ['minimal', 'low', 'medium', 'high', 'xhigh'],
                    description: '可选推理强度档位；省略时继承 ~/.codex/config.toml 默认配置。Optional reasoning effort override.',
                },
                caller: CALLER_SCHEMA_PROPERTY,
                contract: {
                    type: 'object',
                    additionalProperties: false,
                    description: '可选最小任务契约。Optional minimal task contract.',
                    properties: {
                        workspace_mode: {
                            type: 'string',
                            enum: ['snapshot', 'worktree'],
                            description: '默认 "snapshot" 原地快照；"worktree" 创建隔离 Git worktree。Default "snapshot" runs in-place; "worktree" creates an isolated Git worktree.',
                        },
                        expected_files: {
                            type: 'array',
                            items: { type: 'string' },
                            description: '非限制性的预期修改文件提示。Non-restrictive hints of expected files to touch.',
                        },
                        invariants: {
                            type: 'array',
                            items: {
                                type: 'object',
                                additionalProperties: false,
                                required: ['claim'],
                                properties: {
                                    claim: { type: 'string' },
                                    evidence: { type: 'string' },
                                },
                            },
                            description: '带 file:line 证据的可证伪上游假设。Falsifiable upstream hypotheses with file:line evidence.',
                        },
                        acceptance: {
                            type: 'array',
                            items: { type: 'string' },
                            description: '验收标准列表。Acceptance criteria for completion.',
                        },
                        verify_commands: {
                            type: 'array',
                            items: {
                                type: 'object',
                                additionalProperties: false,
                                required: ['argv'],
                                properties: {
                                    argv: {
                                        type: 'array',
                                        items: { type: 'string' },
                                        minItems: 1,
                                    },
                                    timeout_seconds: { type: 'number' },
                                    cwd_rel: { type: 'string' },
                                },
                            },
                            description: 'Codex 完成后在 Passbox MCP 宿主环境中独立执行的结构化 argv 验证命令（无自建 OS 沙箱；也可省略或在环境变量中设置 PASSBOX_DISABLE_VERIFY_COMMANDS=1）。' +
                                'Structured argv verification commands run independently after Codex finishes under the Passbox MCP host environment ' +
                                '(no custom OS sandbox; omit if you prefer running tests in Antigravity, or set PASSBOX_DISABLE_VERIFY_COMMANDS=1).',
                        },
                    },
                },
            },
        },
    },
    {
        name: 'passbox_collect',
        title: 'Passbox Collect',
        description: '事件等待 Passbox 任务并返回 T0->Tk 总账、since_revision 增量 Diff、实际模型、退出原因、独立验证状态及未核验模型声明；无新版本时返回 unchanged=true。' +
            'Event-wait for a Passbox task and return the T0->Tk ledger, incremental diff since ' +
            'since_revision, resolved model, structured exit reason, independent verification status, and unverified executor claims.',
        inputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['task_id'],
            properties: {
                task_id: { type: 'string', description: 'passbox_delegate 返回的任务 ID。Task ID returned by passbox_delegate.' },
                since_revision: {
                    type: 'integer',
                    minimum: 0,
                    description: '调用方已持有的最新修订号（首次收集可省略或传 0）。Last revision already held by the caller (omit or 0 on first collect).',
                },
                wait_seconds: {
                    type: 'number',
                    minimum: 0,
                    maximum: 300,
                    description: '事件等待超时秒数（默认 60；通信超时不会终止后台任务）。Event-driven wait timeout in seconds (default 60). Transport timeout never kills the task.',
                },
                budget: {
                    type: 'object',
                    additionalProperties: false,
                    description: '在 32 KiB 硬上限内的可选字节/行数预算覆盖。Optional byte/line budget overrides within the 32 KiB hard ceiling.',
                    properties: {
                        summary_bytes: { type: 'integer' },
                        preview_bytes: { type: 'integer' },
                        preview_lines: { type: 'integer' },
                        hard_max_bytes: { type: 'integer' },
                    },
                },
            },
        },
    },
    {
        name: 'passbox_steer',
        title: 'Passbox Steer',
        description: '引导现有任务：默认续接原 Codex 线程（CLI 运行中则按 FIFO 排队）；reset_context=true 时停止旧运行并在保留代码与历史修订的前提下开启干净的新线程。' +
            'Steer an existing Passbox task by resuming its native Codex thread (default) or starting a ' +
            'clean Codex session over the current workspace (reset_context=true) while preserving code and archived revisions.',
        inputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['task_id', 'instruction'],
            properties: {
                task_id: { type: 'string', description: '要引导的任务 ID。Task ID to steer.' },
                instruction: {
                    type: 'string',
                    description: '简明的增量指导、已验证事实或反证。Concise delta guidance, verified facts, or counter-evidence.',
                },
                reset_context: {
                    type: 'boolean',
                    description: 'false（默认）续接原 Codex 线程（运行中则排队）；true 停止活跃运行、归档旧会话并开启新 Codex 线程。' +
                        'False (default) resumes existing Codex thread (or queues if active in CLI mode); ' +
                        'true stops any active run, archives old session, and starts a fresh Codex thread.',
                },
                model: {
                    type: 'string',
                    description: '可选覆盖后续运行的 Codex 模型名称。Optional Codex model override for the steered run.',
                },
                reasoning_effort: {
                    type: 'string',
                    enum: ['minimal', 'low', 'medium', 'high', 'xhigh'],
                    description: '可选覆盖后续运行的推理强度。Optional reasoning effort override for the steered run.',
                },
                caller: CALLER_SCHEMA_PROPERTY,
            },
        },
    },
    {
        name: 'passbox_status',
        title: 'Passbox',
        description: '返回精简（<= 512 B）的任务与进程状态摘要，并支持打开 Passbox 双行实时状态面板（侧边栏 / 全局视图）。' +
            'Return a compact (<= 512 B) process and revision status summary and drive the Passbox live status board UI.',
        _meta: {
            ui: {
                resourceUri: PASSBOX_BOARD_RESOURCE_URI,
                visibility: ['model', 'app'],
            },
            'com.google.antigravity/ui': {
                entrypoints: [
                    { type: 'aux_pane', title: 'Passbox' },
                    { type: 'global', title: 'Passbox' },
                ],
            },
        },
        inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                task_id: {
                    type: 'string',
                    description: '要查询的任务 ID（侧边栏/全局入口无参启动时可省略）。Optional Task ID to inspect.',
                },
                include_board: {
                    type: 'boolean',
                    description: '仅用于状态面板 UI 刷新结构化多任务快照（模型文本输出仍保持 <= 512 B）。Attach structured board data for UI rendering.',
                },
            },
        },
    },
    {
        name: 'passbox_recall',
        title: 'Passbox Recall',
        description: '对绑定特定 Recall ID 与修订版本的不可变归档产物（diff、ledger_diff、file_diff、exec_diff、verify_side_effect_diff、range_diff、logs、raw_trace）进行游标分页读取（默认 <= 8 KiB）。' +
            'Cursor-paginate an immutable archived artifact (diff, ledger_diff, file_diff, logs, or raw_trace) ' +
            'bound to a specific Recall ID and revision (<= 8 KiB default page).',
        inputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['recall_id'],
            properties: {
                recall_id: { type: 'string', description: 'passbox_collect 返回的不可变 Recall ID。Immutable Recall ID from passbox_collect.' },
                cursor: {
                    type: 'string',
                    description: '上一页返回的 next_cursor 字节游标（如 "offset:6144"）。Byte cursor returned as next_cursor from previous page (e.g. "offset:6144").',
                },
                limit: {
                    type: 'integer',
                    minimum: 1024,
                    maximum: 32768,
                    description: '本页最大序列化响应字节数（默认 8192）。Maximum serialized response bytes for this page (default 8192).',
                },
            },
        },
    },
    {
        name: 'passbox_cancel',
        title: 'Passbox Cancel',
        description: '请求终止当前活跃的 Passbox 任务进程树，等待真实退出并保留已采集的工作区证据与修订归档。' +
            'Request termination of an active Passbox task execution, wait for actual process exit, ' +
            'and preserve collected workspace evidence and revisions.',
        _meta: {
            ui: {
                visibility: ['model', 'app'],
            },
        },
        inputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['task_id'],
            properties: {
                task_id: { type: 'string', description: '要取消的任务 ID。Task ID to cancel.' },
            },
        },
    },
];
export class PassboxToolDispatcher {
    archive;
    sessionManager;
    firewall;
    constructor(explicitDataDir) {
        this.archive = new ArchiveStore(explicitDataDir);
        this.sessionManager = new SessionManager(this.archive);
        this.firewall = new EvidenceFirewall(this.archive);
    }
    async callTool(toolName, rawArgs = {}, signal) {
        const taskIdHint = typeof rawArgs.task_id === 'string' && rawArgs.task_id.trim() ? rawArgs.task_id.trim() : null;
        const isStatusCall = toolName === 'passbox_status';
        const errorBudget = isStatusCall ? DEFAULT_BUDGETS.statusBytes : 2048;
        try {
            switch (toolName) {
                case 'passbox_delegate': {
                    const res = await this.sessionManager.delegate({
                        objective: String(rawArgs.objective ?? ''),
                        workspace: String(rawArgs.workspace ?? ''),
                        contract: rawArgs.contract,
                        model: typeof rawArgs.model === 'string' ? rawArgs.model : undefined,
                        reasoningEffort: typeof rawArgs.reasoning_effort === 'string'
                            ? rawArgs.reasoning_effort
                            : undefined,
                        caller: rawArgs.caller,
                    });
                    const text = this.firewall.formatControlResponse(res, 4096);
                    return { content: [{ type: 'text', text }] };
                }
                case 'passbox_collect': {
                    const taskId = String(rawArgs.task_id ?? '');
                    const sinceRevision = typeof rawArgs.since_revision === 'number'
                        ? Math.floor(rawArgs.since_revision)
                        : undefined;
                    const waitSeconds = typeof rawArgs.wait_seconds === 'number' ? rawArgs.wait_seconds : 60;
                    const budget = rawArgs.budget;
                    const waited = await this.sessionManager.waitForCollect({
                        taskId,
                        sinceRevision,
                        waitSeconds,
                        signal,
                    });
                    const text = this.firewall.formatCollectResponse({
                        task: waited.task,
                        activeRun: waited.activeRun,
                        sinceRevision,
                        budget,
                        waitedMs: waited.waitedMs,
                    });
                    return { content: [{ type: 'text', text }] };
                }
                case 'passbox_steer': {
                    const res = await this.sessionManager.steer({
                        taskId: String(rawArgs.task_id ?? ''),
                        instruction: String(rawArgs.instruction ?? ''),
                        resetContext: Boolean(rawArgs.reset_context),
                        model: typeof rawArgs.model === 'string' ? rawArgs.model : undefined,
                        reasoningEffort: typeof rawArgs.reasoning_effort === 'string'
                            ? rawArgs.reasoning_effort
                            : undefined,
                        caller: rawArgs.caller,
                    });
                    const text = this.firewall.formatControlResponse(res, 4096);
                    return { content: [{ type: 'text', text }] };
                }
                case 'passbox_status': {
                    const includeBoard = Boolean(rawArgs.include_board);
                    if (taskIdHint && !includeBoard) {
                        const { task, activeRun } = await this.sessionManager.getAndReconcileTask(taskIdHint);
                        const text = this.firewall.formatStatusResponse(task, activeRun);
                        return { content: [{ type: 'text', text }] };
                    }
                    // Entrypoint launch (`{}`) or UI board refresh (`include_board: true`)
                    const board = await this.sessionManager.getBoardSnapshot({
                        focusTaskId: taskIdHint ?? undefined,
                    });
                    let text;
                    if (taskIdHint) {
                        const { task, activeRun } = await this.sessionManager.getAndReconcileTask(taskIdHint);
                        text = this.firewall.formatStatusResponse(task, activeRun);
                    }
                    else {
                        text = this.firewall.formatFleetStatusResponse(board);
                    }
                    return {
                        content: [{ type: 'text', text }],
                        structuredContent: this.firewall.boundBoardStructuredContent(board),
                    };
                }
                case 'passbox_recall': {
                    const recallId = String(rawArgs.recall_id ?? '');
                    const cursor = typeof rawArgs.cursor === 'string' ? rawArgs.cursor : undefined;
                    const limit = typeof rawArgs.limit === 'number' ? Math.floor(rawArgs.limit) : undefined;
                    const text = this.firewall.formatRecallResponse(recallId, cursor, limit);
                    return { content: [{ type: 'text', text }] };
                }
                case 'passbox_cancel': {
                    const res = await this.sessionManager.cancel(String(rawArgs.task_id ?? ''));
                    const text = this.firewall.formatControlResponse(res, 4096);
                    return { content: [{ type: 'text', text }] };
                }
                default: {
                    const errOut = this.firewall.formatErrorResponse(taskIdHint, new Error(`Unknown Passbox tool: "${toolName}"`), errorBudget);
                    return { isError: true, content: [{ type: 'text', text: errOut.text }] };
                }
            }
        }
        catch (err) {
            const errOut = this.firewall.formatErrorResponse(taskIdHint, err, errorBudget);
            return { isError: true, content: [{ type: 'text', text: errOut.text }] };
        }
    }
}
