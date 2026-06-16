#!/usr/bin/env tsx
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
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
  readonly stdoutFile: string | null;
};

type AgentEvent = Record<string, unknown>;

type SseResult = {
  readonly latestSessionId: string | null;
  readonly assistantTextLength: number;
  readonly completeExitCode: number | null;
  readonly errorMessages: readonly string[];
};

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

function resolveOutputPath(inputPath: string): string {
  return path.resolve(expandHome(inputPath));
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
  let stdoutFile: string | null = null;

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
      case '--stdout-file':
        stdoutFile = resolveOutputPath(requireValue(argv, index, arg));
        index += 1;
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
    stdoutFile,
  };
}

function assertNoMessageOptions(argv: readonly string[], command: string): void {
  for (const arg of argv) {
    if (arg === '--message' || arg === '--message-file') {
      throw new Error(`${command} does not accept ${arg}; it sends /compact itself.`);
    }
  }
}

async function parseCompactOptions(argv: readonly string[]): Promise<AppendOptions> {
  assertNoMessageOptions(argv, 'compact');
  return await parseAppendOptions([...argv, '--message', '/compact']);
}

function stringifyJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
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

function readAssistantTextEvent(event: AgentEvent): { readonly id: string; readonly content: string } | null {
  if (event.kind !== 'text' || event.role !== 'assistant' || typeof event.content !== 'string') {
    return null;
  }

  const id = typeof event.id === 'string' && event.id.trim() ? event.id : 'assistant-text';
  return {
    id,
    content: event.content,
  };
}

function readCompleteExitCode(event: AgentEvent): number | null {
  if (event.kind !== 'complete') {
    return null;
  }

  return typeof event.exitCode === 'number' && Number.isInteger(event.exitCode) ? event.exitCode : null;
}

function readErrorMessage(event: AgentEvent): string | null {
  if (event.kind !== 'error') {
    return null;
  }

  if (typeof event.content === 'string' && event.content.trim()) {
    return event.content;
  }

  if (typeof event.message === 'string' && event.message.trim()) {
    return event.message;
  }

  return 'Claude Code returned an error event without a message.';
}

async function writeAudit(auditPath: string, value: unknown): Promise<void> {
  await appendFile(auditPath, stringifyJsonLine(value), 'utf8');
}

async function prepareStdoutFile(stdoutFile: string | null): Promise<void> {
  if (!stdoutFile) {
    return;
  }

  await mkdir(path.dirname(stdoutFile), { recursive: true });
  await writeFile(stdoutFile, '', 'utf8');
}

async function writeStdout(text: string, stdoutFile: string | null): Promise<void> {
  process.stdout.write(text);

  if (stdoutFile) {
    await appendFile(stdoutFile, text, 'utf8');
  }
}

async function consumeSseResponse(
  response: Response,
  auditPath: string,
  jsonl: boolean,
  stdoutFile: string | null,
): Promise<SseResult> {
  if (!response.body) {
    throw new Error('CloudCLI response has no body.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let latestSessionId: string | null = null;
  const assistantTextById = new Map<string, string>();
  let assistantTextLength = 0;
  let completeExitCode: number | null = null;
  const errorMessages: string[] = [];

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

    const eventExitCode = readCompleteExitCode(event);
    if (eventExitCode !== null) {
      completeExitCode = eventExitCode;
    }

    const errorMessage = readErrorMessage(event);
    if (errorMessage) {
      errorMessages.push(errorMessage);
    }

    await writeAudit(auditPath, {
      ts: new Date().toISOString(),
      direction: 'cloudcli_to_codex',
      event,
    });

    if (jsonl) {
      await writeStdout(stringifyJsonLine(event), stdoutFile);
      return;
    }

    const assistantText = readAssistantTextEvent(event);
    if (!assistantText) {
      return;
    }

    const previousText = assistantTextById.get(assistantText.id) ?? '';
    const textToPrint = assistantText.content.startsWith(previousText)
      ? assistantText.content.slice(previousText.length)
      : assistantText.content;
    assistantTextById.set(assistantText.id, assistantText.content);

    if (textToPrint) {
      await writeStdout(textToPrint.endsWith('\n') ? textToPrint : `${textToPrint}\n`, stdoutFile);
      assistantTextLength += textToPrint.length;
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

  return {
    latestSessionId,
    assistantTextLength,
    completeExitCode,
    errorMessages,
  };
}

async function appendToClaudeSession(options: AppendOptions): Promise<void> {
  await mkdir(options.auditDir, { recursive: true });
  await prepareStdoutFile(options.stdoutFile);
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

  const { latestSessionId, assistantTextLength, completeExitCode, errorMessages } = await consumeSseResponse(
    response,
    auditPath,
    options.jsonl,
    options.stdoutFile,
  );
  await writeAudit(auditPath, {
    ts: new Date().toISOString(),
    direction: 'codex_local',
    done: true,
    sessionId: latestSessionId,
    completeExitCode,
    assistantTextLength,
    errorMessages,
  });

  process.stderr.write(`audit: ${auditPath}\n`);
  if (latestSessionId) {
    process.stderr.write(`sessionId: ${latestSessionId}\n`);
  }

  if (errorMessages.length > 0) {
    throw new Error(`Claude Code error: ${errorMessages.join('\n')}`);
  }

  if (completeExitCode !== null && completeExitCode !== 0) {
    throw new Error(`Claude Code exited with status ${completeExitCode}.`);
  }
}

function printUsage(): void {
  process.stderr.write(`Usage:
  npm run claude-subagent -- append --project-path <path> [--session-id <uuid>] (--message <text> | --message-file <path>)
  npm run claude-subagent -- compact --project-path <path> --session-id <uuid>

Options:
  --base-url <url>            CloudCLI base URL. Default: ${DEFAULT_BASE_URL}
  --api-key <key>             CloudCLI API key. Prefer CLOUDCLI_API_KEY or --api-key-file.
  --api-key-file <path>       API key file. Default: ${DEFAULT_API_KEY_FILE}
  --model <model>             Claude model alias. Default: sonnet
  --permission-mode <mode>    Claude Code permission mode. Default: bypassPermissions
  --audit-dir <path>          JSONL audit directory. Default: ${DEFAULT_AUDIT_DIR}
  --jsonl                     Print raw event JSONL instead of assistant Markdown text.
  --stdout-file <path>        Also write stdout output to this UTF-8 file.
`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command !== 'append' && command !== 'compact') {
    printUsage();
    process.exitCode = command ? 1 : 0;
    return;
  }

  const options = command === 'compact' ? await parseCompactOptions(args) : await parseAppendOptions(args);
  await appendToClaudeSession(options);
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`claude-subagent failed: ${message}\n`);
  process.exitCode = 1;
});
