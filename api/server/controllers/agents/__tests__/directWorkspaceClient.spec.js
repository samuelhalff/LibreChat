jest.mock('@librechat/api', () => ({
  GenerationJobManager: {
    emitChunk: jest.fn().mockResolvedValue(undefined),
  },
  sanitizeTitle: jest.fn((value) => value),
  Tokenizer: {
    getTokenCount: jest.fn().mockReturnValue(42),
  },
}));

jest.mock('~/server/services/Endpoints/agents/deterministicWorkspace', () => ({
  buildWorkspaceTaskPrompt: jest.fn().mockReturnValue('delegated prompt'),
  getMessageText: jest.fn((message) => message?.text ?? ''),
  invokeDeterministicLocalAction: jest.fn().mockResolvedValue({
    text: 'result text',
    action: {
      toolName: 'codex_task_run',
    },
  }),
}));

const { GenerationJobManager } = require('@librechat/api');
const {
  invokeDeterministicLocalAction,
} = require('~/server/services/Endpoints/agents/deterministicWorkspace');
const DirectWorkspaceClient = require('../directWorkspaceClient');

describe('DirectWorkspaceClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('stores BaseClient options needed by the resumable request path', async () => {
    const req = { _resumableStreamId: 'stream-123' };
    const res = { locals: {} };
    const agent = {
      id: 'agent-123',
      name: 'codex-5.4-high',
      model_parameters: { model: 'qwen3.5:2b' },
    };
    const client = new DirectWorkspaceClient({
      req,
      res,
      sender: 'codex-5.4-high',
      agent,
      endpoint: 'agents',
      directDispatch: {
        toolName: 'codex_task_run',
        workspace: 'ark-fid.ch',
        role: 'codex-5.4-high',
      },
    });
    client.responseMessageId = 'response-123';

    const result = await client.sendCompletion('delegated prompt', {
      abortController: { signal: 'signal-123' },
    });

    expect(client.options.req).toBe(req);
    expect(client.options.res).toBe(res);
    expect(client.getSaveOptions()).toMatchObject({
      endpoint: 'agents',
      agent_id: 'agent-123',
    });
    expect(GenerationJobManager.emitChunk).toHaveBeenCalledWith('stream-123', {
      event: 'on_agent_update',
      data: {
        type: 'agent_update',
        agent_update: {
          runId: 'response-123',
          index: 0,
          agentId: 'agent-123',
          message: 'codex-5.4-high is working in ark-fid.ch...',
        },
      },
    });
    expect(invokeDeterministicLocalAction).toHaveBeenCalledWith(
      expect.objectContaining({
        req,
        res,
        agent,
        action: {
          kind: 'tool',
          actionType: 'workspace_task',
          toolName: 'codex_task_run',
          toolArgs: {
            workspace: 'ark-fid.ch',
            timeout_seconds: undefined,
            role: 'codex-5.4-high',
          },
          promptMode: 'workspace_context',
          progressMessage: 'codex-5.4-high is working in ark-fid.ch...',
          metadata: {
            deterministic_workspace_dispatch: {
              tool: 'codex_task_run',
              workspace: 'ark-fid.ch',
            },
          },
        },
        prompt: 'delegated prompt',
        signal: 'signal-123',
      }),
    );
    expect(result).toMatchObject({
      completion: 'result text',
      metadata: {
        deterministic_workspace_dispatch: {
          tool: 'codex_task_run',
          workspace: 'ark-fid.ch',
        },
      },
    });
  });

  it('can return a deterministic fallback message without invoking MCP', async () => {
    const client = new DirectWorkspaceClient({
      req: { _resumableStreamId: 'stream-123' },
      res: { locals: {} },
      sender: 'codex-5.4-high',
      agent: {
        id: 'agent-123',
        name: 'codex-5.4-high',
        model_parameters: { model: 'qwen3.5:2b' },
      },
      endpoint: 'agents',
      directAction: {
        kind: 'message',
        actionType: 'message',
        responseText: 'Name a workspace under /home/sam/dev.',
        metadata: {
          deterministic_local_action: {
            kind: 'message',
          },
        },
      },
    });

    invokeDeterministicLocalAction.mockResolvedValueOnce({
      text: 'Name a workspace under /home/sam/dev.',
      action: { kind: 'message' },
    });

    await expect(client.sendCompletion('latest text')).resolves.toMatchObject({
      completion: 'Name a workspace under /home/sam/dev.',
      metadata: {
        deterministic_local_action: {
          kind: 'message',
        },
      },
    });
  });

  it('derives a deterministic conversation title from the latest user prompt', async () => {
    const client = new DirectWorkspaceClient({
      req: { _resumableStreamId: 'stream-123' },
      res: { locals: {} },
      sender: 'codex-5.4-high',
      agent: {
        id: 'agent-123',
        name: 'codex-5.4-high',
        model_parameters: { model: 'qwen3.5:2b' },
      },
      endpoint: 'agents',
      directAction: {
        kind: 'message',
        actionType: 'message',
        responseText: 'ok',
      },
    });

    await expect(
      client.titleConvo({
        text: 'In ark-fid.ch, tell me which file handles the contact form submit logic. Reply with just the path.',
      }),
    ).resolves.toBe('In ark-fid.ch, tell me which file handles the contact form submit logic');
  });
});
