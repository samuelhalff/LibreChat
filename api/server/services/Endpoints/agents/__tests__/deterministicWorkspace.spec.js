const mockInvoke = jest.fn();
const mockCreateMCPTool = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock('@librechat/api', () => ({
  createSafeUser: jest.fn((user) => ({ id: user?.id ?? 'user-123' })),
}));

jest.mock('librechat-data-provider', () => ({
  Constants: {
    mcp_delimiter: ':',
  },
}));

jest.mock('~/server/services/MCP', () => ({
  createMCPTool: (...args) => mockCreateMCPTool(...args),
}));

describe('deterministicWorkspace routing', () => {
  const req = {
    user: { id: 'user-123' },
  };
  const res = {};
  const agent = {
    name: 'codex-5.4-high',
    provider: 'agents',
  };
  const workspaceListResult = {
    content: JSON.stringify({
      workspaces: [
        {
          name: 'ark-fid.ch',
          ref: 'ark-fid.ch',
          path: '/home/sam/dev/ark-fid.ch',
        },
      ],
    }),
  };

  beforeEach(() => {
    jest.resetModules();
    mockInvoke.mockReset();
    mockCreateMCPTool.mockReset();
    mockInvoke.mockResolvedValue(workspaceListResult);
    mockCreateMCPTool.mockResolvedValue({
      invoke: mockInvoke,
    });
  });

  it('recognizes a bare workspace name and returns a targeted follow-up message', async () => {
    const { resolveDeterministicLocalAction } = require('../deterministicWorkspace');

    const action = await resolveDeterministicLocalAction({
      req,
      res,
      agent,
      text: 'ark-fid.ch',
      signal: new AbortController().signal,
    });

    expect(action).toMatchObject({
      kind: 'message',
      actionType: 'message',
    });
    expect(action.responseText).toContain('Workspace recognized: ark-fid.ch.');
    expect(action.responseText).toContain('Include the task in the same message');
  });

  it('recognizes speech-friendly aliases for a bare workspace selection', async () => {
    const { resolveDeterministicLocalAction } = require('../deterministicWorkspace');

    const action = await resolveDeterministicLocalAction({
      req,
      res,
      agent,
      text: 'ark fid',
      signal: new AbortController().signal,
    });

    expect(action).toMatchObject({
      kind: 'message',
      actionType: 'message',
    });
    expect(action.responseText).toContain('Workspace recognized: ark-fid.ch.');
  });

  it('dispatches workspace-prefixed tasks even when the container cannot see /home/sam/dev', async () => {
    const { resolveDeterministicLocalAction } = require('../deterministicWorkspace');

    const action = await resolveDeterministicLocalAction({
      req,
      res,
      agent,
      text: 'ark-fid.ch tell me which file handles the contact form submit logic.',
      signal: new AbortController().signal,
    });

    expect(action).toMatchObject({
      kind: 'tool',
      actionType: 'workspace_task',
      toolName: 'codex_task_run',
      promptMode: 'workspace_context',
    });
    expect(action.toolArgs).toMatchObject({
      workspace: '/home/sam/dev/ark-fid.ch',
      timeout_seconds: 240,
      role: 'codex-5.4-high',
    });
  });

  it('dispatches workspace tasks for speech-friendly aliases', async () => {
    const { resolveDeterministicLocalAction } = require('../deterministicWorkspace');

    const action = await resolveDeterministicLocalAction({
      req,
      res,
      agent,
      text: 'in ark fid tell me which file handles the contact form submit logic.',
      signal: new AbortController().signal,
    });

    expect(action).toMatchObject({
      kind: 'tool',
      actionType: 'workspace_task',
      toolName: 'codex_task_run',
      promptMode: 'workspace_context',
    });
    expect(action.toolArgs).toMatchObject({
      workspace: '/home/sam/dev/ark-fid.ch',
      timeout_seconds: 240,
      role: 'codex-5.4-high',
    });
  });
});
