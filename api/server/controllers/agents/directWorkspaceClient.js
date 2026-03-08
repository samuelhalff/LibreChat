const path = require('path');
const { logger } = require('@librechat/data-schemas');
const { GenerationJobManager, Tokenizer, sanitizeTitle } = require('@librechat/api');
const { EModelEndpoint } = require('librechat-data-provider');
const BaseClient = require('~/app/clients/BaseClient');
const {
  buildWorkspaceTaskPrompt,
  getMessageText,
  invokeDeterministicLocalAction,
} = require('~/server/services/Endpoints/agents/deterministicWorkspace');

const MAX_TITLE_CHARS = 80;

function buildDeterministicTitle(text) {
  if (typeof text !== 'string') {
    return undefined;
  }

  const normalized = text
    .replace(/\s+/g, ' ')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
  if (!normalized) {
    return undefined;
  }

  const firstLine = normalized.split(/\r?\n/, 1)[0].trim();
  const sentence = firstLine.split(/[.?!](?:\s|$)/, 1)[0].trim() || firstLine;
  const compact =
    sentence.length > MAX_TITLE_CHARS
      ? `${sentence.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`
      : sentence;

  return sanitizeTitle(compact);
}

class DirectWorkspaceClient extends BaseClient {
  constructor(options = {}) {
    super(null, options);
    const { artifactPromises, directAction, directDispatch, ...clientOptions } = options;
    this.clientName = EModelEndpoint.agents;
    this.contextStrategy = null;
    this.options = Object.assign({ endpoint: options.endpoint }, clientOptions);
    this.model =
      this.options.agent?.model_parameters?.model ??
      this.options.agent?.model ??
      'direct-workspace';
    this.directAction =
      directAction ??
      (directDispatch
        ? {
            kind: 'tool',
            actionType: 'workspace_task',
            toolName: directDispatch.toolName,
            toolArgs: {
              workspace: directDispatch.workspace,
              timeout_seconds: directDispatch.timeoutSeconds,
              ...(directDispatch.role ? { role: directDispatch.role } : {}),
            },
            promptMode: 'workspace_context',
            progressMessage: `${this.options.agent?.name ?? 'Agent'} is working in ${path.basename(directDispatch.workspace)}...`,
            metadata: {
              deterministic_workspace_dispatch: {
                tool: directDispatch.toolName,
                workspace: directDispatch.workspace,
              },
            },
          }
        : null);
    this.contentParts = [];
    this.collectedUsage = [];
    this.artifactPromises = artifactPromises ?? [];
    this.skipBalanceCheck = true;
  }

  getSaveOptions() {
    return {
      spec: this.options.spec,
      iconURL: this.options.iconURL,
      endpoint: this.options.endpoint,
      agent_id: this.options.agent?.id,
      resendFiles: this.options.resendFiles,
      imageDetail: this.options.imageDetail,
      maxContextTokens: this.options.maxContextTokens,
    };
  }

  getBuildMessagesOptions() {
    return {};
  }

  async buildMessages(messages) {
    const latestMessage = messages[messages.length - 1];
    const latestText = getMessageText(latestMessage);
    const prompt =
      this.directAction?.promptMode === 'workspace_context'
        ? buildWorkspaceTaskPrompt({ messages, latestText })
        : latestText;

    return {
      prompt,
      promptTokens: this.getTokenCount(prompt),
      tokenCountMap: latestMessage?.messageId
        ? { [latestMessage.messageId]: this.getTokenCount(latestText) }
        : undefined,
      messages,
    };
  }

  async sendCompletion(payload, opts = {}) {
    const streamId = this.options.req?._resumableStreamId;
    if (streamId && this.directAction?.progressMessage) {
      await GenerationJobManager.emitChunk(streamId, {
        event: 'on_agent_update',
        data: {
          runId: this.responseMessageId,
          message: this.directAction.progressMessage,
        },
      });
    }

    const result = await invokeDeterministicLocalAction({
      req: this.options.req,
      res: this.options.res,
      agent: this.options.agent,
      action: this.directAction,
      prompt: payload,
      responseMessageId: this.responseMessageId,
      conversationId: this.conversationId,
      parentMessageId: this.parentMessageId,
      signal: opts.abortController?.signal ?? this.abortController?.signal,
      userMCPAuthMap: this.options.userMCPAuthMap,
    });

    return {
      completion: result.text,
      metadata: this.directAction?.metadata,
    };
  }

  getTokenCountForResponse(responseMessage) {
    return this.getTokenCount(responseMessage?.text ?? '');
  }

  checkVisionRequest() {}

  async titleConvo({ text }) {
    return buildDeterministicTitle(text);
  }

  async recordTokenUsage() {
    logger.debug('[DirectWorkspaceClient] Skipping model token accounting for direct workspace tool');
  }

  getEncoding() {
    return 'o200k_base';
  }

  getTokenCount(text) {
    return Tokenizer.getTokenCount(text ?? '', this.getEncoding());
  }
}

module.exports = DirectWorkspaceClient;
