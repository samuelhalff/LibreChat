const fs = require('fs');
const path = require('path');
const { logger } = require('@librechat/data-schemas');
const { createSafeUser } = require('@librechat/api');
const { Constants } = require('librechat-data-provider');
const { createMCPTool } = require('~/server/services/MCP');

const DEV_ROOT = '/home/sam/dev';
const SCRATCH_ROOT = path.join(DEV_ROOT, '_scratch');
const AI_SYSTEM_SERVER = 'ai-system';
const RESERVED_WORKSPACES = new Set(['_archive', '_scratch', '_templates']);
const MAX_CONTEXT_MESSAGES = 6;
const MAX_CONTEXT_CHARS = 6000;
const MAX_MESSAGE_CHARS = 1200;
const WORKSPACE_LIST_CACHE_TTL_MS = 60 * 1000;
const DEFAULT_QUEUE_LIST_LIMIT = 20;
const STRUCTURED_QUEUE_PREFIX = 'Manage the persistent local prompt queue using only named MCP tools.';
const QUEUE_STATUSES = new Set([
  'active',
  'queued',
  'running',
  'all',
  'finished',
  'failed',
  'timed_out',
  'cancelled',
]);
const LOCAL_AGENT_HELP_TEXT =
  'This local worker is deterministic. Name a workspace under /home/sam/dev, ask to list workspaces, or use /queue, /queue-list, /queue-run-next, /steer, or /queue-cancel.';

const deterministicAgentMap = {
  'codex-5.4-high': {
    toolName: 'codex_task_run',
    role: 'codex-5.4-high',
    timeoutSeconds: 240,
  },
  'codex-5.4-xhigh': {
    toolName: 'codex_task_run',
    role: 'codex-5.4-xhigh',
    timeoutSeconds: 240,
  },
  'copilot-sonnet': {
    toolName: 'copilot_task_run',
    role: 'copilot-sonnet',
    timeoutSeconds: 240,
  },
  'copilot-x0': {
    toolName: 'copilot_x0_run',
    timeoutSeconds: 45,
  },
  'opus-4.6-deep': {
    toolName: 'opus_task_run',
    timeoutSeconds: 240,
  },
  'system-admin': {
    toolName: 'codex_task_run',
    role: 'system-admin',
    timeoutSeconds: 240,
  },
};

const workspaceListCache = {
  expiresAt: 0,
  entries: null,
};

const deterministicAgentNames = new Set(Object.keys(deterministicAgentMap));

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

function normalizeTemplateValue(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  if (!normalized || normalized.includes('{{') || normalized.includes('}}')) {
    return null;
  }

  return normalized;
}

function canonicalizeRole(value) {
  const normalized = normalizeTemplateValue(value)?.toLowerCase();
  if (!normalized) {
    return null;
  }

  for (const role of deterministicAgentNames) {
    if (role.toLowerCase() === normalized) {
      return role;
    }
  }

  return null;
}

function defaultRoleForAgent(agent) {
  return canonicalizeRole(agent?.name) ?? 'copilot-x0';
}

function extractRoleFromText(text) {
  if (typeof text !== 'string') {
    return null;
  }

  for (const role of deterministicAgentNames) {
    const pattern = new RegExp(`(^|[^a-z0-9.-])${escapeRegExp(role)}(?=$|[^a-z0-9.-])`, 'i');
    if (pattern.test(text)) {
      return role;
    }
  }

  return null;
}

function trimMessageText(text, maxChars = MAX_MESSAGE_CHARS) {
  if (typeof text !== 'string') {
    return '';
  }

  const normalized = text.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars).trimEnd()}\n...[truncated]`;
}

function normalizeFsPath(candidate) {
  try {
    return fs.realpathSync.native(candidate);
  } catch (_error) {
    return path.resolve(candidate);
  }
}

function listWorkspaceEntries({ devRoot = DEV_ROOT, scratchRoot = SCRATCH_ROOT } = {}) {
  /** @type {Array<{ path: string; ref: string; name: string; target: string }>} */
  const entries = [];

  const loadChildren = (root, mapEntry, filter) => {
    try {
      const children = fs.readdirSync(root, { withFileTypes: true });
      for (const child of children) {
        if (filter(child.name)) {
          continue;
        }
        let isDir = child.isDirectory();
        if (!isDir && child.isSymbolicLink()) {
          try {
            isDir = fs.statSync(path.join(root, child.name)).isDirectory();
          } catch {
            /* skip broken symlinks */
          }
        }
        if (!isDir) {
          continue;
        }

        const workspacePath = path.join(root, child.name);
        entries.push(
          mapEntry({
            name: child.name,
            path: workspacePath,
            target: normalizeFsPath(workspacePath),
          }),
        );
      }
    } catch (_error) {
      // If the workspace root is unavailable we simply skip deterministic dispatch.
    }
  };

  loadChildren(
    devRoot,
    (entry) => ({ ...entry, ref: entry.name }),
    (name) =>
      name.startsWith('.') || RESERVED_WORKSPACES.has(name) || name.endsWith('.worktrees'),
  );

  loadChildren(
    scratchRoot,
    (entry) => ({ ...entry, ref: `_scratch/${entry.name}` }),
    (name) => name.startsWith('.'),
  );

  return entries.sort((a, b) => a.ref.localeCompare(b.ref));
}

function workspaceAliases(entry) {
  const values = [entry.name, entry.ref, path.basename(entry.path), path.basename(entry.target)];
  const aliases = new Set();

  for (const value of values) {
    if (!value) {
      continue;
    }

    const normalized = value.trim().replace(/^\/+|\/+$/g, '').toLowerCase();
    if (!normalized) {
      continue;
    }

    aliases.add(normalized);
    aliases.add(slugify(normalized));
  }

  return aliases;
}

function workspaceRootForPath(candidate, entries) {
  const normalizedCandidate = normalizeFsPath(candidate);

  for (const entry of entries) {
    if (
      normalizedCandidate === entry.target ||
      normalizedCandidate === entry.path ||
      normalizedCandidate.startsWith(`${entry.target}${path.sep}`) ||
      normalizedCandidate.startsWith(`${entry.path}${path.sep}`)
    ) {
      return entry.path;
    }
  }

  return null;
}

function cleanWorkspaceRef(ref) {
  if (typeof ref !== 'string') {
    return null;
  }

  const cleaned = ref.trim().replace(/^[`'"]+|[`'"]+$/g, '').replace(/[.,:;!?)\]}'"]+$/g, '');
  return cleaned || null;
}

function parseBulletValue(text, label) {
  if (typeof text !== 'string' || typeof label !== 'string') {
    return null;
  }

  const pattern = new RegExp(`^-\\s*${escapeRegExp(label)}:\\s*(.+)$`, 'im');
  const match = text.match(pattern);
  return normalizeTemplateValue(match?.[1] ?? null);
}

function parseTrailingValue(text, label) {
  if (typeof text !== 'string' || typeof label !== 'string') {
    return null;
  }

  const pattern = new RegExp(`^-\\s*${escapeRegExp(label)}:\\s*\\n([\\s\\S]+)$`, 'im');
  const match = text.match(pattern);
  return normalizeTemplateValue(match?.[1] ?? null);
}

function resolveWorkspaceRef(ref, entries = listWorkspaceEntries()) {
  const cleaned = cleanWorkspaceRef(ref);
  if (!cleaned) {
    return null;
  }

  const lookupPaths = [
    cleaned,
    path.join(DEV_ROOT, cleaned),
    path.join(SCRATCH_ROOT, cleaned),
    path.join(DEV_ROOT, slugify(cleaned)),
    path.join(SCRATCH_ROOT, slugify(cleaned)),
  ];

  for (const candidate of lookupPaths) {
    if (!fs.existsSync(candidate)) {
      continue;
    }

    const workspace = workspaceRootForPath(candidate, entries);
    if (workspace) {
      return workspace;
    }
  }

  const normalizedRef = cleaned.replace(/^\/+|\/+$/g, '').toLowerCase();
  const aliasMatches = entries.filter((entry) => workspaceAliases(entry).has(normalizedRef));
  if (aliasMatches.length === 1) {
    return aliasMatches[0].path;
  }

  return null;
}

function extractWorkspaceHintFromText(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return null;
  }

  const absoluteMatch = text.match(/\/home\/sam\/dev\/[A-Za-z0-9._/\-]+/);
  if (absoluteMatch?.[0]) {
    return cleanWorkspaceRef(absoluteMatch[0]);
  }

  const reservedMatch = text.match(/(?:_scratch|_templates|_archive)\/[A-Za-z0-9._-]+/);
  if (reservedMatch?.[0]) {
    return cleanWorkspaceRef(reservedMatch[0]);
  }

  const contextualPatterns = [
    /\b(?:workspace|repo|project)\s+[`'"]?([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?)\b/i,
    /\b(?:in|inside|under|within|for)\s+[`'"]?([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?)\b/i,
  ];

  for (const pattern of contextualPatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return cleanWorkspaceRef(match[1]);
    }
  }

  const quotedMatch = text.match(/[`'"]([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?)['"`]/);
  if (quotedMatch?.[1]) {
    return cleanWorkspaceRef(quotedMatch[1]);
  }

  return null;
}

function inferWorkspaceFromText(text, entries = listWorkspaceEntries()) {
  if (typeof text !== 'string' || text.trim() === '') {
    return null;
  }

  const candidateRefs =
    text.match(/\/home\/sam\/dev\/[A-Za-z0-9._/\-]+|(?:_scratch|_templates|_archive)\/[A-Za-z0-9._-]+/g) ??
    [];
  for (const candidate of candidateRefs) {
    const resolved = resolveWorkspaceRef(candidate, entries);
    if (resolved) {
      return resolved;
    }
  }

  const lowered = text.toLowerCase();
  /** @type {Map<string, number>} */
  const matches = new Map();
  for (const entry of entries) {
    for (const alias of workspaceAliases(entry)) {
      const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(alias)}(?=$|[^a-z0-9])`, 'i');
      if (!pattern.test(lowered)) {
        continue;
      }

      const currentScore = matches.get(entry.path) ?? 0;
      if (alias.length > currentScore) {
        matches.set(entry.path, alias.length);
      }
    }
  }

  if (matches.size !== 1) {
    if (matches.size > 1) {
      logger.debug('[DeterministicWorkspace] Ambiguous workspace match in user prompt', {
        prompt: trimMessageText(text, 240),
        matches: Array.from(matches.keys()),
      });
    }
    return null;
  }

  return Array.from(matches.keys())[0];
}

function getMessageText(message) {
  if (message == null) {
    return '';
  }

  if (typeof message.text === 'string' && message.text.trim()) {
    return message.text;
  }

  if (typeof message.content === 'string' && message.content.trim()) {
    return message.content;
  }

  if (!Array.isArray(message.content)) {
    return '';
  }

  return message.content
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      if (typeof part?.text === 'string') {
        return part.text;
      }
      if (typeof part?.output === 'string') {
        return part.output;
      }
      if (typeof part?.refusal === 'string') {
        return part.refusal;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function buildWorkspaceTaskPrompt({ messages = [], latestText }) {
  const currentText = trimMessageText(latestText ?? getMessageText(messages[messages.length - 1]), 2400);
  if (!currentText) {
    return '';
  }

  /** @type {string[]} */
  const historyBlocks = [];
  let totalChars = currentText.length;

  for (let index = messages.length - 2; index >= 0; index -= 1) {
    const message = messages[index];
    const text = trimMessageText(getMessageText(message));
    if (!text) {
      continue;
    }

    const role = message.role ?? (message.isCreatedByUser ? 'user' : 'assistant');
    const block = `[${role}] ${text}`;
    if (historyBlocks.length > 0 && totalChars + block.length > MAX_CONTEXT_CHARS) {
      break;
    }

    historyBlocks.unshift(block);
    totalChars += block.length;

    if (historyBlocks.length >= MAX_CONTEXT_MESSAGES) {
      break;
    }
  }

  if (historyBlocks.length === 0) {
    return currentText;
  }

  return [
    'Conversation context (oldest to newest, trimmed):',
    historyBlocks.join('\n\n'),
    '',
    'Current user request (verbatim):',
    currentText,
  ].join('\n');
}

function getDeterministicWorkspaceDispatch({ agent, text, skip = false }) {
  if (skip) {
    return null;
  }

  const runtime = deterministicAgentMap[agent?.name];
  if (!runtime || typeof text !== 'string' || text.trim() === '') {
    return null;
  }

  const workspace = extractWorkspaceHintFromText(text) ?? inferWorkspaceFromText(text);
  if (!workspace) {
    return null;
  }

  return { ...runtime, workspace };
}

function parseWorkspaceEntriesResult(content) {
  const normalized = normalizeToolText(content);
  if (!normalized) {
    return [];
  }

  try {
    const parsed = JSON.parse(normalized);
    const workspaces = Array.isArray(parsed?.workspaces) ? parsed.workspaces : [];
    return workspaces
      .map((workspace) => {
        if (!workspace || typeof workspace !== 'object') {
          return null;
        }

        const name = typeof workspace.name === 'string' ? workspace.name : '';
        const ref = typeof workspace.ref === 'string' ? workspace.ref : name;
        const workspacePath = typeof workspace.path === 'string' ? workspace.path : ref;
        return {
          name,
          ref,
          path: workspacePath,
          target: workspacePath,
        };
      })
      .filter(Boolean);
  } catch (_error) {
    return [];
  }
}

async function loadWorkspaceEntriesFromMcp({ req, res, agent, signal, userMCPAuthMap }) {
  if (workspaceListCache.entries && workspaceListCache.expiresAt > Date.now()) {
    return workspaceListCache.entries;
  }

  const tool = await createMCPTool({
    res,
    user: req.user,
    provider: agent?.provider ?? 'agents',
    streamId: req?._resumableStreamId || null,
    userMCPAuthMap,
    toolKey: `workspace_list${Constants.mcp_delimiter}${AI_SYSTEM_SERVER}`,
  });

  if (!tool) {
    return [];
  }

  const result = await tool.invoke(
    {},
    {
      signal,
      toolCall: {
        id: 'direct_workspace_list',
        stepId: 'step_direct_workspace_list',
        turn: 0,
      },
      configurable: {
        thread_id: 'direct-workspace-list',
        user_id: req.user?.id,
        user: createSafeUser(req.user),
        requestBody: {},
        ...(userMCPAuthMap != null && { userMCPAuthMap }),
      },
      metadata: {
        provider: agent?.provider ?? 'agents',
        run_id: 'direct-workspace-list',
        thread_id: 'direct-workspace-list',
      },
    },
  );

  const entries = parseWorkspaceEntriesResult(result?.content);
  workspaceListCache.entries = entries;
  workspaceListCache.expiresAt = Date.now() + WORKSPACE_LIST_CACHE_TTL_MS;
  return entries;
}

const FIXED_WORKSPACE_AGENTS = {
  'system-admin': '/home/sam/ai-system',
};

async function resolveDeterministicWorkspaceDispatch({
  req,
  res,
  agent,
  text,
  signal,
  userMCPAuthMap,
  skip = false,
}) {
  const fixedWorkspace = FIXED_WORKSPACE_AGENTS[agent?.name];
  if (fixedWorkspace && !skip) {
    const runtime = deterministicAgentMap[agent?.name];
    if (runtime) {
      return { ...runtime, workspace: fixedWorkspace };
    }
  }

  const directDispatch = getDeterministicWorkspaceDispatch({ agent, text, skip });
  if (directDispatch) {
    return directDispatch;
  }

  if (skip) {
    return null;
  }

  const runtime = deterministicAgentMap[agent?.name];
  if (!runtime || typeof text !== 'string' || text.trim() === '') {
    return null;
  }

  if (!hasPotentialWorkspaceHint(text)) {
    return null;
  }

  const entries = await loadWorkspaceEntriesFromMcp({ req, res, agent, signal, userMCPAuthMap });
  const workspace = inferWorkspaceFromText(text, entries);
  if (!workspace) {
    return null;
  }

  return { ...runtime, workspace };
}

function isDeterministicAgent(agent) {
  return deterministicAgentNames.has(agent?.name);
}

function createLocalToolAction({
  actionType,
  toolName,
  toolArgs = {},
  progressMessage,
  metadata,
  promptMode = 'latest_text',
}) {
  return {
    kind: 'tool',
    actionType,
    toolName,
    toolArgs,
    progressMessage,
    metadata,
    promptMode,
  };
}

function createLocalMessageAction(text) {
  return {
    kind: 'message',
    actionType: 'message',
    responseText: text,
    metadata: {
      deterministic_local_action: {
        kind: 'message',
      },
    },
    promptMode: 'latest_text',
  };
}

function buildLocalAgentFallbackMessage() {
  return LOCAL_AGENT_HELP_TEXT;
}

function parseIntValue(value) {
  const normalized = normalizeTemplateValue(value);
  if (!normalized || !/^\d+$/.test(normalized)) {
    return null;
  }

  return Number.parseInt(normalized, 10);
}

function extractQueueId(text) {
  if (typeof text !== 'string') {
    return null;
  }

  const match = text.match(/\b([a-f0-9]{8,32})\b/i);
  return match?.[1] ?? null;
}

function extractQueueStatus(text) {
  if (typeof text !== 'string') {
    return null;
  }

  const normalized = text.toLowerCase();
  for (const status of QUEUE_STATUSES) {
    const pattern = new RegExp(`(^|[^a-z_])${escapeRegExp(status)}(?=$|[^a-z_])`, 'i');
    if (pattern.test(normalized)) {
      return status;
    }
  }

  return null;
}

function extractQueueLimit(text) {
  if (typeof text !== 'string') {
    return null;
  }

  const match = text.match(/\blimit\s+(\d+)\b/i) ?? text.match(/\bshow\s+(\d+)\b/i);
  if (!match?.[1]) {
    return null;
  }

  return Number.parseInt(match[1], 10);
}

function extractQueuedPrompt(text) {
  if (typeof text !== 'string') {
    return null;
  }

  const match =
    text.match(/\b(?:queue|enqueue)\b[\s\S]*?\bto\b[:\s]+([\s\S]+)$/i) ??
    text.match(/\bprompt\b\s*:\s*([\s\S]+)$/i);
  const extracted = normalizeTemplateValue(match?.[1] ?? null);
  if (extracted) {
    return extracted;
  }

  return normalizeTemplateValue(text);
}

function parseSlashQueueAction(text, agent) {
  if (typeof text !== 'string') {
    return null;
  }

  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  const [firstLine, ...restLines] = trimmed.split(/\r?\n/);
  const body = restLines.join('\n').trim();
  const firstTokens = firstLine.trim().split(/\s+/).filter(Boolean);
  const command = firstTokens[0]?.toLowerCase();

  if (command === '/queue-list') {
    const status = extractQueueStatus(firstLine);
    const limit = extractQueueLimit(firstLine) ?? DEFAULT_QUEUE_LIST_LIMIT;
    return createLocalToolAction({
      actionType: 'queue_list',
      toolName: 'prompt_queue_list',
      toolArgs: {
        limit,
        ...(status ? { status } : {}),
      },
      progressMessage: 'checking the queue...',
      metadata: {
        deterministic_local_action: {
          kind: 'queue_list',
        },
      },
    });
  }

  if (command === '/queue-run-next') {
    const queueId = firstTokens[1] ?? null;
    return createLocalToolAction({
      actionType: 'queue_run_next',
      toolName: 'prompt_queue_run_next',
      toolArgs: queueId ? { queue_id: queueId } : {},
      progressMessage: 'starting queued work...',
      metadata: {
        deterministic_local_action: {
          kind: 'queue_run_next',
          ...(queueId ? { queue_id: queueId } : {}),
        },
      },
    });
  }

  if (command === '/queue-cancel') {
    const queueId = firstTokens[1] ?? null;
    if (!queueId) {
      return createLocalMessageAction('queue_id is required for /queue-cancel.');
    }

    return createLocalToolAction({
      actionType: 'queue_cancel',
      toolName: 'prompt_queue_cancel',
      toolArgs: { queue_id: queueId },
      progressMessage: `cancelling queued item ${queueId}...`,
      metadata: {
        deterministic_local_action: {
          kind: 'queue_cancel',
          queue_id: queueId,
        },
      },
    });
  }

  if (command === '/steer') {
    const queueId = firstTokens[1] ?? null;
    const instruction = normalizeTemplateValue(
      body || firstTokens.slice(2).join(' '),
    );
    if (!queueId || !instruction) {
      return createLocalMessageAction('queue_id and instruction are required for /steer.');
    }

    return createLocalToolAction({
      actionType: 'queue_steer',
      toolName: 'prompt_queue_steer',
      toolArgs: {
        queue_id: queueId,
        instruction,
      },
      progressMessage: `steering queued item ${queueId}...`,
      metadata: {
        deterministic_local_action: {
          kind: 'queue_steer',
          queue_id: queueId,
        },
      },
    });
  }

  if (command === '/queue') {
    const naturalText = `Queue ${[firstTokens.slice(1).join(' '), body].filter(Boolean).join(' ').trim()}`.trim();
    if (naturalText !== 'Queue') {
      return parseNaturalQueueAction(naturalText, agent);
    }

    return createLocalMessageAction(
      'Use /queue with the filled queue prompt, or say: Queue a task for <workspace> using <role> to <task>.',
    );
  }

  return null;
}

function parseStructuredQueueAction(text, agent) {
  if (typeof text !== 'string' || !text.trimStart().startsWith(STRUCTURED_QUEUE_PREFIX)) {
    return null;
  }

  if (text.includes('Queue a new workspace task with these exact values:')) {
    const workspace = parseBulletValue(text, 'workspace');
    const role = canonicalizeRole(parseBulletValue(text, 'role')) ?? defaultRoleForAgent(agent);
    const dispatch = parseBulletValue(text, 'dispatch');
    const prompt = parseTrailingValue(text, 'prompt');
    if (!prompt) {
      return createLocalMessageAction('Queue prompt text is required.');
    }

    return createLocalToolAction({
      actionType: 'queue_add',
      toolName: 'prompt_queue_add',
      toolArgs: {
        ...(workspace ? { workspace } : {}),
        prompt,
        role,
        start_immediately: dispatch === 'start-now',
      },
      progressMessage: dispatch === 'start-now' ? 'queueing and starting work...' : 'queueing work...',
      metadata: {
        deterministic_local_action: {
          kind: 'queue_add',
          role,
          ...(workspace ? { workspace } : {}),
          start_immediately: dispatch === 'start-now',
        },
      },
    });
  }

  if (text.includes('List queued prompts with these exact values:')) {
    const status = parseBulletValue(text, 'status');
    const limit = parseIntValue(parseBulletValue(text, 'limit')) ?? DEFAULT_QUEUE_LIST_LIMIT;
    return createLocalToolAction({
      actionType: 'queue_list',
      toolName: 'prompt_queue_list',
      toolArgs: {
        limit,
        ...(status ? { status } : {}),
      },
      progressMessage: 'checking the queue...',
      metadata: {
        deterministic_local_action: {
          kind: 'queue_list',
          ...(status ? { status } : {}),
        },
      },
    });
  }

  if (text.includes('Start queued work with these exact values:')) {
    const queueId = parseBulletValue(text, 'queue_id');
    return createLocalToolAction({
      actionType: 'queue_run_next',
      toolName: 'prompt_queue_run_next',
      toolArgs: queueId ? { queue_id: queueId } : {},
      progressMessage: 'starting queued work...',
      metadata: {
        deterministic_local_action: {
          kind: 'queue_run_next',
          ...(queueId ? { queue_id: queueId } : {}),
        },
      },
    });
  }

  if (text.includes('Cancel queued or running work with this exact value:')) {
    const queueId = parseBulletValue(text, 'queue_id');
    if (!queueId) {
      return createLocalMessageAction('queue_id is required to cancel queued work.');
    }

    return createLocalToolAction({
      actionType: 'queue_cancel',
      toolName: 'prompt_queue_cancel',
      toolArgs: { queue_id: queueId },
      progressMessage: `cancelling queued item ${queueId}...`,
      metadata: {
        deterministic_local_action: {
          kind: 'queue_cancel',
          queue_id: queueId,
        },
      },
    });
  }

  if (text.includes('Steer an existing queued prompt with these exact values:')) {
    const queueId = parseBulletValue(text, 'queue_id');
    const instruction = parseTrailingValue(text, 'instruction');
    if (!queueId || !instruction) {
      return createLocalMessageAction('queue_id and instruction are required to steer queued work.');
    }

    return createLocalToolAction({
      actionType: 'queue_steer',
      toolName: 'prompt_queue_steer',
      toolArgs: {
        queue_id: queueId,
        instruction,
      },
      progressMessage: `steering queued item ${queueId}...`,
      metadata: {
        deterministic_local_action: {
          kind: 'queue_steer',
          queue_id: queueId,
        },
      },
    });
  }

  return null;
}

function parseNaturalQueueAction(text, agent) {
  if (typeof text !== 'string' || text.trim() === '') {
    return null;
  }

  const normalized = text.trim();

  if (
    /\b(?:queue[-\s]?list|list (?:the )?queue|show (?:the )?queue|what(?:'s| is) (?:in )?the queue|queue status)\b/i.test(
      normalized,
    )
  ) {
    const status = extractQueueStatus(normalized);
    return createLocalToolAction({
      actionType: 'queue_list',
      toolName: 'prompt_queue_list',
      toolArgs: {
        limit: extractQueueLimit(normalized) ?? DEFAULT_QUEUE_LIST_LIMIT,
        ...(status ? { status } : {}),
      },
      progressMessage: 'checking the queue...',
      metadata: {
        deterministic_local_action: {
          kind: 'queue_list',
          ...(status ? { status } : {}),
        },
      },
    });
  }

  if (
    /\b(?:queue[-\s]?run[-\s]?next|run the next queued item|run next queue|start next queue|start the next queued item)\b/i.test(
      normalized,
    )
  ) {
    const queueId = extractQueueId(normalized);
    return createLocalToolAction({
      actionType: 'queue_run_next',
      toolName: 'prompt_queue_run_next',
      toolArgs: queueId ? { queue_id: queueId } : {},
      progressMessage: 'starting queued work...',
      metadata: {
        deterministic_local_action: {
          kind: 'queue_run_next',
          ...(queueId ? { queue_id: queueId } : {}),
        },
      },
    });
  }

  if (
    /\b(?:queue[-\s]?cancel|cancel (?:the )?queue|cancel queued (?:item|prompt)|cancel queue)\b/i.test(
      normalized,
    )
  ) {
    const queueId = extractQueueId(normalized);
    if (!queueId) {
      return createLocalMessageAction('queue_id is required to cancel queued work.');
    }

    return createLocalToolAction({
      actionType: 'queue_cancel',
      toolName: 'prompt_queue_cancel',
      toolArgs: { queue_id: queueId },
      progressMessage: `cancelling queued item ${queueId}...`,
      metadata: {
        deterministic_local_action: {
          kind: 'queue_cancel',
          queue_id: queueId,
        },
      },
    });
  }

  if (
    /\b(?:queue[-\s]?steer|steer queue|steer queued|update queue)\b/i.test(normalized)
  ) {
    const queueId = extractQueueId(normalized);
    const instruction =
      normalizeTemplateValue(
        normalized.match(/\b(?:to|focus on|with)\b[:\s]+([\s\S]+)$/i)?.[1] ?? null,
      ) ??
      normalizeTemplateValue(normalized.replace(/\b(?:queue[-\s]?steer|steer queue|steer queued|update queue)\b/i, '').replace(queueId ?? '', '').trim());

    if (!queueId || !instruction) {
      return createLocalMessageAction('queue_id and instruction are required to steer queued work.');
    }

    return createLocalToolAction({
      actionType: 'queue_steer',
      toolName: 'prompt_queue_steer',
      toolArgs: {
        queue_id: queueId,
        instruction,
      },
      progressMessage: `steering queued item ${queueId}...`,
      metadata: {
        deterministic_local_action: {
          kind: 'queue_steer',
          queue_id: queueId,
        },
      },
    });
  }

  if (/\b(?:queue|enqueue)\b/i.test(normalized)) {
    const role = extractRoleFromText(normalized) ?? defaultRoleForAgent(agent);
    const workspace = extractWorkspaceHintFromText(normalized);
    const prompt = extractQueuedPrompt(normalized);
    if (!prompt) {
      return createLocalMessageAction('Queue prompt text is required.');
    }

    const startImmediately = /\b(?:start now|run now|start immediately|queue and run|run immediately)\b/i.test(
      normalized,
    );

    return createLocalToolAction({
      actionType: 'queue_add',
      toolName: 'prompt_queue_add',
      toolArgs: {
        ...(workspace ? { workspace } : {}),
        prompt,
        role,
        start_immediately: startImmediately,
      },
      progressMessage: startImmediately ? 'queueing and starting work...' : 'queueing work...',
      metadata: {
        deterministic_local_action: {
          kind: 'queue_add',
          role,
          ...(workspace ? { workspace } : {}),
          start_immediately: startImmediately,
        },
      },
    });
  }

  return null;
}

function parseQueueAction(text, agent) {
  return (
    parseSlashQueueAction(text, agent) ??
    parseStructuredQueueAction(text, agent) ??
    parseNaturalQueueAction(text, agent)
  );
}

function parseWorkspaceListAction(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return null;
  }

  if (
    /\b(?:workspace list|list workspaces|show workspaces|what workspaces|which workspaces|available workspaces|list projects|show projects|what projects|which projects)\b/i.test(
      text,
    )
  ) {
    return createLocalToolAction({
      actionType: 'workspace_list',
      toolName: 'workspace_list',
      toolArgs: {},
      progressMessage: 'listing workspaces...',
      metadata: {
        deterministic_local_action: {
          kind: 'workspace_list',
        },
      },
    });
  }

  return null;
}

function hasPotentialWorkspaceHint(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return false;
  }

  if (
    /\/home\/sam\/dev\/[A-Za-z0-9._/\-]+/.test(text) ||
    /(?:_scratch|_templates|_archive)\/[A-Za-z0-9._-]+/.test(text)
  ) {
    return true;
  }

  return [
    /\b(?:workspace|repo|project)\s+[`'"]?[A-Za-z0-9][A-Za-z0-9._-]*(?:\s+[A-Za-z0-9][A-Za-z0-9._-]*){0,3}\b/i,
    /\b(?:in|inside|under|within)\s+[`'"]?[A-Za-z0-9][A-Za-z0-9._-]*(?:\s+[A-Za-z0-9][A-Za-z0-9._-]*){0,3}\b/i,
  ].some((pattern) => pattern.test(text));
}

async function resolveDeterministicLocalAction({
  req,
  res,
  agent,
  text,
  signal,
  userMCPAuthMap,
  skip = false,
}) {
  if (skip || !isDeterministicAgent(agent) || typeof text !== 'string' || text.trim() === '') {
    return null;
  }

  const queueAction = parseQueueAction(text, agent);
  if (queueAction) {
    return queueAction;
  }

  const workspaceListAction = parseWorkspaceListAction(text);
  if (workspaceListAction) {
    return workspaceListAction;
  }

  const workspaceDispatch = await resolveDeterministicWorkspaceDispatch({
    req,
    res,
    agent,
    text,
    signal,
    userMCPAuthMap,
    skip,
  });

  if (workspaceDispatch) {
    return createLocalToolAction({
      actionType: 'workspace_task',
      toolName: workspaceDispatch.toolName,
      toolArgs: {
        workspace: workspaceDispatch.workspace,
        timeout_seconds: workspaceDispatch.timeoutSeconds,
        ...(workspaceDispatch.role ? { role: workspaceDispatch.role } : {}),
      },
      progressMessage: `${agent?.name ?? 'Agent'} is working in ${path.basename(workspaceDispatch.workspace)}...`,
      metadata: {
        deterministic_workspace_dispatch: {
          tool: workspaceDispatch.toolName,
          workspace: workspaceDispatch.workspace,
        },
      },
      promptMode: 'workspace_context',
    });
  }

  return createLocalMessageAction(buildLocalAgentFallbackMessage());
}

function normalizeToolText(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map((item) => normalizeToolText(item)).filter(Boolean).join('\n');
  }

  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') {
      return content.text;
    }

    if (Array.isArray(content.content)) {
      return normalizeToolText(content.content);
    }

    try {
      return JSON.stringify(content, null, 2);
    } catch (_error) {
      return String(content);
    }
  }

  if (content == null) {
    return '';
  }

  return String(content);
}

function parseStructuredToolContent(content) {
  if (Array.isArray(content)) {
    for (const item of content) {
      const parsed = parseStructuredToolContent(item);
      if (parsed != null) {
        return parsed;
      }
    }
    return null;
  }

  if (content && typeof content === 'object') {
    if (Array.isArray(content.content)) {
      const parsed = parseStructuredToolContent(content.content);
      if (parsed != null) {
        return parsed;
      }
    }

    if (typeof content.text === 'string') {
      const parsed = parseStructuredToolContent(content.text);
      if (parsed != null) {
        return parsed;
      }
    }

    return content;
  }

  if (typeof content !== 'string') {
    return null;
  }

  const normalized = content.trim();
  if (!normalized.startsWith('{') && !normalized.startsWith('[')) {
    return null;
  }

  try {
    return JSON.parse(normalized);
  } catch (_error) {
    return null;
  }
}

function formatStructuredToolContent(content) {
  const parsed = parseStructuredToolContent(content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  if (parsed.ok === false && typeof parsed.error === 'string' && parsed.error.trim()) {
    return parsed.error.trim();
  }

  if (typeof parsed.summary === 'string' && parsed.summary.trim()) {
    return parsed.summary.trim();
  }

  if (typeof parsed.note === 'string' && parsed.note.trim()) {
    return parsed.note.trim();
  }

  if (typeof parsed.error === 'string' && parsed.error.trim()) {
    return parsed.error.trim();
  }

  if (typeof parsed.status === 'string' && parsed.status.trim()) {
    const exitCode =
      typeof parsed.exit_code === 'number' || typeof parsed.exit_code === 'string'
        ? ` (exit ${parsed.exit_code})`
        : '';
    return `Task ${parsed.status}${exitCode}`;
  }

  return null;
}

function formatWorkspaceListContent(content) {
  const parsed = parseStructuredToolContent(content);
  const workspaces = Array.isArray(parsed?.workspaces) ? parsed.workspaces : null;
  if (!workspaces) {
    return null;
  }

  if (workspaces.length === 0) {
    return 'No workspaces found under /home/sam/dev.';
  }

  return workspaces
    .map((workspace) => {
      const ref = normalizeTemplateValue(workspace?.ref) ?? normalizeTemplateValue(workspace?.name);
      const stack = normalizeTemplateValue(workspace?.stack);
      const scope = workspace?.scope === 'scratch' ? 'scratch' : null;
      const flags = [stack, scope].filter(Boolean).join(' | ');
      return flags ? `- ${ref} (${flags})` : `- ${ref}`;
    })
    .join('\n');
}

function formatQueueEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const lines = [
    `**queue_id**: ${entry.id ?? entry.queue_id ?? 'unknown'}`,
    `**status**: ${entry.status ?? 'unknown'}`,
    `**role**: ${entry.role ?? 'unknown'}`,
    `**workspace**: ${entry.workspace ?? entry.cwd ?? 'unknown'}`,
  ];

  const taskId = entry.started_task?.task_id ?? entry.task_id;
  if (taskId) {
    lines.push(`**task_id**: ${taskId}`);
  }

  if (typeof entry.steer_count === 'number') {
    lines.push(`**steer_count**: ${entry.steer_count}`);
  }

  if (typeof entry.task_status === 'string' && entry.task_status.trim()) {
    lines.push(`**task_status**: ${entry.task_status}`);
  }

  return lines.join('\n');
}

function formatQueueListContent(content) {
  const parsed = parseStructuredToolContent(content);
  const queue = Array.isArray(parsed?.queue) ? parsed.queue : null;
  if (!queue) {
    return null;
  }

  if (queue.length === 0) {
    return 'queue empty';
  }

  return queue
    .map((entry) => {
      const preview = normalizeTemplateValue(entry?.prompt_preview) ?? '';
      const updatedAt = normalizeTemplateValue(entry?.updated_at) ?? 'unknown';
      return `- ${entry.id} | ${entry.status} | ${entry.role} | ${entry.workspace} | ${updatedAt} | ${preview}`;
    })
    .join('\n');
}

function formatQueueToolContent(toolName, content) {
  if (toolName === 'prompt_queue_list') {
    return formatQueueListContent(content);
  }

  const parsed = parseStructuredToolContent(content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  return formatQueueEntry(parsed);
}

function formatAiSystemToolContent(toolName, content) {
  if (toolName === 'workspace_list') {
    return formatWorkspaceListContent(content) ?? formatStructuredToolContent(content);
  }

  if (toolName.startsWith('prompt_queue_')) {
    return formatQueueToolContent(toolName, content) ?? formatStructuredToolContent(content);
  }

  return formatStructuredToolContent(content);
}

function buildToolArguments(action, prompt) {
  const args = { ...(action.toolArgs ?? {}) };
  if (typeof prompt === 'string' && prompt.trim()) {
    if (args.prompt == null && action.promptMode === 'workspace_context') {
      args.prompt = prompt;
    }
  }

  return args;
}

async function invokeDeterministicLocalAction({
  req,
  res,
  agent,
  action,
  prompt,
  responseMessageId,
  conversationId,
  parentMessageId = null,
  signal,
  userMCPAuthMap,
}) {
  if (!action) {
    throw new Error('Deterministic local action not configured');
  }

  if (action.kind === 'message') {
    return {
      text: action.responseText,
      rawResult: null,
      action,
    };
  }

  if (action.kind !== 'tool' || !action.toolName) {
    throw new Error('Unsupported deterministic local action');
  }

  const tool = await createMCPTool({
    res,
    user: req.user,
    provider: agent?.provider ?? 'agents',
    streamId: req?._resumableStreamId || null,
    userMCPAuthMap,
    toolKey: `${action.toolName}${Constants.mcp_delimiter}${AI_SYSTEM_SERVER}`,
  });

  if (!tool) {
    throw new Error(`Failed to initialize MCP tool ${action.toolName}`);
  }

  logger.debug('[DeterministicWorkspace] Invoking local action directly', {
    agent: agent?.name,
    tool: action.toolName,
    conversationId,
    responseMessageId,
    actionType: action.actionType,
  });

  const result = await tool.invoke(buildToolArguments(action, prompt), {
    signal,
    toolCall: {
      id: `direct_${responseMessageId}`,
      stepId: `step_direct_${responseMessageId}`,
      turn: 0,
    },
    configurable: {
      thread_id: conversationId,
      user_id: req.user?.id,
      user: createSafeUser(req.user),
      requestBody: {
        messageId: responseMessageId,
        conversationId,
        parentMessageId,
      },
      ...(userMCPAuthMap != null && { userMCPAuthMap }),
    },
    metadata: {
      provider: agent?.provider ?? 'agents',
      run_id: responseMessageId,
      thread_id: conversationId,
    },
  });

  return {
    text:
      formatAiSystemToolContent(action.toolName, result?.content) ??
      normalizeToolText(result?.content),
    rawResult: result,
    action,
  };
}

async function invokeDeterministicWorkspaceTool({
  req,
  res,
  agent,
  dispatch,
  prompt,
  responseMessageId,
  conversationId,
  parentMessageId = null,
  signal,
  userMCPAuthMap,
}) {
  if (!dispatch) {
    throw new Error('Deterministic workspace dispatch not configured');
  }

  const action = createLocalToolAction({
    actionType: 'workspace_task',
    toolName: dispatch.toolName,
    toolArgs: {
      workspace: dispatch.workspace,
      timeout_seconds: dispatch.timeoutSeconds,
      ...(dispatch.role ? { role: dispatch.role } : {}),
    },
    progressMessage: `working in ${path.basename(dispatch.workspace)}...`,
    metadata: {
      deterministic_workspace_dispatch: {
        tool: dispatch.toolName,
        workspace: dispatch.workspace,
      },
    },
    promptMode: 'workspace_context',
  });

  const result = await invokeDeterministicLocalAction({
    req,
    res,
    agent,
    action,
    prompt,
    responseMessageId,
    conversationId,
    parentMessageId,
    signal,
    userMCPAuthMap,
  });

  return {
    text: result.text,
    rawResult: result.rawResult,
    dispatch,
  };
}

module.exports = {
  AI_SYSTEM_SERVER,
  DEV_ROOT,
  buildWorkspaceTaskPrompt,
  buildLocalAgentFallbackMessage,
  extractWorkspaceHintFromText,
  getDeterministicWorkspaceDispatch,
  getMessageText,
  inferWorkspaceFromText,
  invokeDeterministicLocalAction,
  invokeDeterministicWorkspaceTool,
  isDeterministicAgent,
  listWorkspaceEntries,
  normalizeToolText,
  parseStructuredToolContent,
  resolveDeterministicLocalAction,
  resolveDeterministicWorkspaceDispatch,
};
