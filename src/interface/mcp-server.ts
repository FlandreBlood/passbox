#!/usr/bin/env node
/**
 * Passbox M1 stdio MCP server.
 * Supports both newline-delimited JSON-RPC 2.0 (MCP 2024-11-05 / 2025-03-26)
 * and Content-Length framed JSON-RPC 2.0, including MCP Apps (`ui://passbox/board.html`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getPassboxBoardHtml,
  PASSBOX_BOARD_MIME_TYPE,
  PASSBOX_BOARD_RESOURCE_URI,
} from './board-ui.js';
import { PASSBOX_MCP_TOOLS, PassboxToolDispatcher } from './tools.js';

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));

function resolveServerVersion(): string {
  for (const rel of [
    ['..', '..', '.antigravity-plugin', 'plugin.json'],
    ['..', '..', 'plugin.json'],
    ['..', '..', 'package.json'],
  ]) {
    try {
      const p = path.resolve(SELF_DIR, ...rel);
      if (fs.existsSync(p)) {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as { version?: string };
        if (typeof parsed.version === 'string' && parsed.version.trim()) {
          return parsed.version.trim();
        }
      }
    } catch {}
  }
  return '0.2.0';
}

const SERVER_VERSION = resolveServerVersion();
const dispatcher = new PassboxToolDispatcher();
const inFlightControllers = new Map<string | number, AbortController>();

let framingMode: 'jsonl' | 'content-length' = 'jsonl';

function writeRpcMessage(payloadObj: Record<string, unknown>): void {
  const serialized = JSON.stringify(payloadObj);
  if (framingMode === 'content-length') {
    const byteLen = Buffer.byteLength(serialized, 'utf8');
    process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${serialized}`);
  } else {
    process.stdout.write(`${serialized}\n`);
  }
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

async function handleJsonRpcMessage(msg: JsonRpcRequest): Promise<void> {
  if (!msg || typeof msg !== 'object') return;

  // Handle notifications (no `id` property)
  if (!Object.prototype.hasOwnProperty.call(msg, 'id') || msg.id === undefined) {
    if (msg.method === 'notifications/cancelled') {
      const reqId = msg.params?.requestId as string | number | undefined;
      if (reqId !== undefined) {
        const ctrl = inFlightControllers.get(reqId);
        ctrl?.abort();
      }
    }
    return;
  }

  const id = msg.id;
  const method = msg.method ?? '';
  const params = msg.params ?? {};

  try {
    switch (method) {
      case 'initialize': {
        const clientProto = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        const negotiated = clientProto === '2025-03-26' ? '2025-03-26' : '2024-11-05';
        writeRpcMessage({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: negotiated,
            capabilities: {
              tools: {},
              resources: {},
            },
            serverInfo: {
              name: 'passbox',
              version: SERVER_VERSION,
            },
            instructions:
              'Passbox 跨 Harness 编排服务 / cross-harness orchestration server. ' +
              '当用户通过 /passbox 显式调用时使用 / Invoke via /passbox skill when requested: ' +
              'passbox_delegate -> passbox_collect -> optional passbox_recall / passbox_steer / passbox_cancel.',
          },
        });
        return;
      }

      case 'ping': {
        writeRpcMessage({ jsonrpc: '2.0', id, result: {} });
        return;
      }

      case 'tools/list': {
        writeRpcMessage({
          jsonrpc: '2.0',
          id,
          result: { tools: PASSBOX_MCP_TOOLS },
        });
        return;
      }

      case 'resources/list': {
        writeRpcMessage({
          jsonrpc: '2.0',
          id,
          result: {
            resources: [
              {
                uri: PASSBOX_BOARD_RESOURCE_URI,
                name: 'Passbox Status Board',
                description:
                  'Passbox 跨 Harness 双行实时任务状态与证据审计面板（支持中文/英文切换） / Live multi-agent status & evidence board',
                mimeType: PASSBOX_BOARD_MIME_TYPE,
                _meta: {
                  ui: {
                    prefersBorder: false,
                  },
                },
              },
            ],
          },
        });
        return;
      }

      case 'resources/templates/list': {
        writeRpcMessage({
          jsonrpc: '2.0',
          id,
          result: { resourceTemplates: [] },
        });
        return;
      }

      case 'resources/read': {
        const uri = typeof params.uri === 'string' ? params.uri : '';
        if (uri !== PASSBOX_BOARD_RESOURCE_URI) {
          writeRpcMessage({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32602,
              message: `Unknown resource URI: ${uri}`,
            },
          });
          return;
        }
        writeRpcMessage({
          jsonrpc: '2.0',
          id,
          result: {
            contents: [
              {
                uri: PASSBOX_BOARD_RESOURCE_URI,
                mimeType: PASSBOX_BOARD_MIME_TYPE,
                text: getPassboxBoardHtml(),
                _meta: {
                  ui: {
                    prefersBorder: false,
                  },
                },
              },
            ],
          },
        });
        return;
      }

      case 'tools/call': {
        const toolName = typeof params.name === 'string' ? params.name : '';
        const toolArgs =
          params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
            ? (params.arguments as Record<string, unknown>)
            : {};
        const rawMeta =
          params._meta && typeof params._meta === 'object' && !Array.isArray(params._meta)
            ? (params._meta as Record<string, unknown>)
            : undefined;
        const progressToken =
          typeof rawMeta?.progressToken === 'string' || typeof rawMeta?.progressToken === 'number'
            ? rawMeta.progressToken
            : undefined;

        const ctrl = new AbortController();
        if (id !== null) {
          inFlightControllers.set(id, ctrl);
        }
        try {
          const result = await dispatcher.callTool(
            toolName,
            toolArgs,
            ctrl.signal,
            progressToken !== undefined
              ? (info) => {
                  writeRpcMessage({
                    jsonrpc: '2.0',
                    method: 'notifications/progress',
                    params: {
                      progressToken,
                      progress: info.progress,
                      ...(info.total !== undefined ? { total: info.total } : {}),
                      ...(info.message ? { message: info.message } : {}),
                    },
                  });
                }
              : undefined
          );
          writeRpcMessage({ jsonrpc: '2.0', id, result });
        } finally {
          if (id !== null) {
            inFlightControllers.delete(id);
          }
        }
        return;
      }

      default: {
        writeRpcMessage({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: `Method not found: ${method}`,
          },
        });
        return;
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message.slice(0, 512) : 'Internal MCP error';
    writeRpcMessage({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message,
      },
    });
  }
}

let inputBuffer = Buffer.alloc(0);

function tryConsumeContentLength(): boolean {
  framingMode = 'content-length';
  const sep = inputBuffer.indexOf('\r\n\r\n');
  if (sep === -1) return false;
  const header = inputBuffer.subarray(0, sep).toString('utf8');
  const match = /Content-Length:\s*(\d+)/i.exec(header);
  if (!match) {
    inputBuffer = inputBuffer.subarray(sep + 4);
    return true;
  }
  const bodyBytes = Number(match[1]);
  const start = sep + 4;
  if (inputBuffer.length < start + bodyBytes) return false;
  const body = inputBuffer.subarray(start, start + bodyBytes).toString('utf8');
  inputBuffer = inputBuffer.subarray(start + bodyBytes);
  try {
    void handleJsonRpcMessage(JSON.parse(body) as JsonRpcRequest);
  } catch {}
  return true;
}

function tryConsumeJsonLine(): boolean {
  const nl = inputBuffer.indexOf(0x0a);
  if (nl === -1) return false;
  const line = inputBuffer.subarray(0, nl).toString('utf8').trim();
  inputBuffer = inputBuffer.subarray(nl + 1);
  if (line) {
    try {
      void handleJsonRpcMessage(JSON.parse(line) as JsonRpcRequest);
    } catch {}
  }
  return true;
}

function drainInputBuffer(): void {
  while (inputBuffer.length > 0) {
    const prefix = inputBuffer.subarray(0, Math.min(inputBuffer.length, 64)).toString('utf8');
    const progressed = /^Content-Length:/i.test(prefix)
      ? tryConsumeContentLength()
      : tryConsumeJsonLine();
    if (!progressed) return;
  }
}

process.stdin.on('data', (chunk: Buffer | string) => {
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
  inputBuffer = Buffer.concat([inputBuffer, buf]);
  drainInputBuffer();
});

process.stdin.on('end', () => {
  for (const ctrl of inFlightControllers.values()) {
    ctrl.abort();
  }
});
