#!/usr/bin/env tsx
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

type PermissionMode = 'acceptEdits' | 'auto' | 'bypassPermissions' | 'default' | 'dontAsk' | 'plan';

type AppendOptions = {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly projectPath: string;
  readonly sessionId: string | null;
  readonly message: string;
  readonly model: string;
  readonly permissionMode: PermissionMode;
  readonly auditDir: string;
  readonly jsonl: boolean;
};

type AgentEvent = Record<string, unknown>;

const PERMISSION_MODES = new Set<PermissionMode>([
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
]);

const DEFAULT_BASE_URL = 'http://127.0.0.1:31783';
const DEFAULT_API_KEY_FILE = path.join(os.homedir(), 'experiment', 'cloudcli-data', 'codex-subagent-api-key');
const DEFAULT_AUDIT_DIR = path.join(os.homedir(), 'experiment', 'cloudcli-subagent-audit');

function expandHome(inputPath: string): string {
  if (inputPath === '~') {
    return os.homedir();
  }

  if (inputPath.startsWith('~/')) {
    return path.join(os.homedir(), inputPath.slice(2));
  }

  return inputPath;
}

function requireValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value) {
    throw new Error(`${option} requires a value.`);
  }

  return value;
}

async function readUtf8File(filePath: string): Promise<string> {
  return await readFile(expandHome(filePath), 'utf8');
}

async function readApiKeyFromFile(filePath: string): Promise<string> {
  const apiKey = (await readUtf8File(filePath)).trim();
  if (!apiKey) {
    throw new Error(`API key file is empty: ${filePath}`);
  }

  return apiKey;
}

function readPermissionMode(value: string): PermissionMode {
  if (!PERMISSION_MODES.has(value as PermissionMode)) {
    throw new Error(`permission mode must be one of: ${Array.from(PERMISSION_MODES).join(', ')}`);
  }

  return value as PermissionMode;
}

async function parseAppendOptions(argv: readonly string[]): Promise<AppendOptions> {
  let baseUrl = process.env.CLOUDCLI_BASE_URL || DEFAULT_BASE_URL;
  let apiKey = process.env.CLOUDCLI_API_KEY || '';
  let apiKeyFile = process.env.CLOUDCLI_API_KEY_FILE || DEFAULT_API_KEY_FILE;
  let projectPath = '';
  let sessionId: string | null = null;
  let message = '';
  let messageFile = '';
  let model = 'sonnet';
  let permissionMode: PermissionMode = 'bypassPermissions';
  let auditDir = process.env.CLOUDCLI_SUBAGENT_AUDIT_DIR || DEFAULT_AUDIT_DIR;
  let jsonl = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case '--base-url':
        baseUrl = requireValue(argv, index, arg);
        index += 1;
        break;
      case '--api-key':
        apiKey = requireValue(argv, index, arg);
        index += 1;
        break;
      case '--api-key-file':
        apiKeyFile = requireValue(argv, index, arg);
        index += 1;
        break;
      case '--project-path':
        projectPath = expandHome(requireValue(argv, index, arg));
        index += 1;
        break;
      case '--session-id':
        sessionId = requireValue(argv, index, arg);
        index += 1;
        break;
      case '--message':
        message = requireValue(argv, index, arg);
        index += 1;
        break;
      case '--message-file':
        messageFile = requireValue(argv, index, arg);
        index += 1;
        break;
      case '--model':
        model = requireValue(argv, index, arg);
        index += 1;
        break;
      case '--permission-mode':
        permissionMode = readPermissionMode(requireValue(argv, index, arg));
        index += 1;
        break;
      case '--audit-dir':
        auditDir = expandHome(requireValue(argv, index, arg));
        index += 1;
        break;
      case '--jsonl':
        jsonl = true;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }

  if (!apiKey) {
    apiKey = await readApiKeyFromFile(apiKeyFile);
  }

  if (!projectPath) {
    throw new Error('--project-path is required.');
  }

  if (messageFile) {
    message = await readUtf8File(messageFile);
  }

  if (!message.trim()) {
    throw new Error('--message or --message-file is required.');
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    projectPath,
    sessionId,
    message,
    model,
    permissionMode,
    auditDir,
    jsonl,
  };
}

function stringifyJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function extractTextParts(value: unknown, depth = 0): string[] {
  if (depth > 4 || value === null || value === undefined) {
    return [];
  }

  if (typeof value === 'string') {
    return value.trim() ? [value] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => extractTextParts(item, depth + 1));
  }

  if (typeof value !== 'object') {
    return [];
  }

  const record = value as Record<string, unknown>;
  const directText = typeof record.text === 'string' ? [record.text] : [];
  const contentText = typeof record.content === 'string' ? [record.content] : extractTextParts(record.content, depth + 1);
  const messageText = extractTextParts(record.message, depth + 1);
  const dataText = extractTextParts(record.data, depth + 1);

  return [...directText, ...contentText, ...messageText, ...dataText].filter((text) => text.trim().length > 0);
}

function readSessionIdFromEvent(event: AgentEvent): string | null {
  const directSessionId = event.sessionId;
  if (typeof directSessionId === 'string' && directSessionId.trim()) {
    return directSessionId;
  }

  const data = event.data;
  if (data && typeof data === 'object' && 'sessionId' in data) {
    const dataSessionId = (data as Record<string, unknown>).sessionId;
    if (typeof dataSessionId === 'string' && dataSessionId.trim()) {
      return dataSessionId;
    }
  }

  return null;
}

async function writeAudit(auditPath: string, value: unknown): Promise<void> {
  await appendFile(auditPath, stringifyJsonLine(value), 'utf8');
}

async function consumeSseResponse(response: Response, auditPath: string, jsonl: boolean): Promise<string | null> {
  if (!response.body) {
    throw new Error('CloudCLI response has no body.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let latestSessionId: string | null = null;

  const processBlock = async (block: string): Promise<void> => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('\n')
      .trim();

    if (!data) {
      return;
    }

    const event = JSON.parse(data) as AgentEvent;
    const eventSessionId = readSessionIdFromEvent(event);
    if (eventSessionId) {
      latestSessionId = eventSessionId;
    }

    await writeAudit(auditPath, {
      ts: new Date().toISOString(),
      direction: 'cloudcli_to_codex',
      event,
    });

    if (jsonl) {
      process.stdout.write(stringifyJsonLine(event));
      return;
    }

    for (const text of extractTextParts(event)) {
      process.stdout.write(`${text}\n`);
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? '';

    for (const block of blocks) {
      await processBlock(block);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    await processBlock(buffer);
  }

  return latestSessionId;
}

async function appendToClaudeSession(options: AppendOptions): Promise<void> {
  await mkdir(options.auditDir, { recursive: true });
  const auditPath = path.join(options.auditDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);

  const requestBody = {
    provider: 'claude',
    projectPath: options.projectPath,
    sessionId: options.sessionId,
    message: options.message,
    model: options.model,
    permissionMode: options.permissionMode,
    stream: true,
    cleanup: false,
  };

  await writeAudit(auditPath, {
    ts: new Date().toISOString(),
    direction: 'codex_to_cloudcli',
    request: {
      ...requestBody,
      messageLength: options.message.length,
    },
  });

  const response = await fetch(`${options.baseUrl}/api/agent`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': options.apiKey,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const body = await response.text();
    await writeAudit(auditPath, {
      ts: new Date().toISOString(),
      direction: 'cloudcli_to_codex',
      error: {
        status: response.status,
        body,
      },
    });
    throw new Error(`CloudCLI /api/agent failed with ${response.status}: ${body}`);
  }

  const latestSessionId = await consumeSseResponse(response, auditPath, options.jsonl);
  await writeAudit(auditPath, {
    ts: new Date().toISOString(),
    direction: 'codex_local',
    done: true,
    sessionId: latestSessionId,
  });

  process.stderr.write(`audit: ${auditPath}\n`);
  if (latestSessionId) {
    process.stderr.write(`sessionId: ${latestSessionId}\n`);
  }
}

function printUsage(): void {
  process.stderr.write(`Usage:
  npm run claude-subagent -- append --project-path <path> [--session-id <uuid>] (--message <text> | --message-file <path>)

Options:
  --base-url <url>            CloudCLI base URL. Default: ${DEFAULT_BASE_URL}
  --api-key <key>             CloudCLI API key. Prefer CLOUDCLI_API_KEY or --api-key-file.
  --api-key-file <path>       API key file. Default: ${DEFAULT_API_KEY_FILE}
  --model <model>             Claude model alias. Default: sonnet
  --permission-mode <mode>    Claude Code permission mode. Default: bypassPermissions
  --audit-dir <path>          JSONL audit directory. Default: ${DEFAULT_AUDIT_DIR}
  --jsonl                     Print raw event JSONL instead of extracted text.
`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command !== 'append') {
    printUsage();
    process.exitCode = command ? 1 : 0;
    return;
  }

  const options = await parseAppendOptions(args);
  await appendToClaudeSession(options);
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`claude-subagent failed: ${message}\n`);
  process.exitCode = 1;
});
