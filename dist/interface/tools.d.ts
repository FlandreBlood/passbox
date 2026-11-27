import { EvidenceFirewall } from '../firewall/index.js';
import { ArchiveStore } from '../observability/index.js';
import { SessionManager } from '../session/index.js';
export interface McpToolDefinition {
    name: string;
    title?: string;
    description: string;
    inputSchema: Record<string, unknown>;
    _meta?: Record<string, unknown>;
}
export interface McpToolCallResult {
    isError?: boolean;
    content: Array<{
        type: 'text';
        text: string;
    }>;
    structuredContent?: Record<string, unknown>;
}
export declare const PASSBOX_MCP_TOOLS: McpToolDefinition[];
export declare class PassboxToolDispatcher {
    readonly archive: ArchiveStore;
    readonly sessionManager: SessionManager;
    readonly firewall: EvidenceFirewall;
    constructor(explicitDataDir?: string);
    callTool(toolName: string, rawArgs?: Record<string, unknown>, signal?: AbortSignal, onProgress?: (info: {
        progress: number;
        total?: number;
        message?: string;
    }) => void): Promise<McpToolCallResult>;
}
