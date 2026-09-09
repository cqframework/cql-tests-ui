// Author: Preston Lee

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MCPToolNames } from '@cql-studio/core';
import {
  createOpencode,
  createOpencodeClient,
  type Event,
  type FilePartInput,
  type OpencodeClient,
} from '@opencode-ai/sdk/v2';
import type {
  CreateOpenCodeSessionRequest,
  OpenCodeAttachmentDto,
  OpenCodeAttachmentUploadRequest,
  OpenCodeModelSwitchRequest,
  OpenCodeCommandDto,
  OpenCodeActiveFileSyncRequest,
  OpenCodeEventEnvelope,
  OpenCodeFileDiffDto,
  OpenCodeFileReferenceDto,
  OpenCodePermissionRequestDto,
  OpenCodeQuestionRequestDto,
  OpenCodePermissionResponse,
  OpenCodePromptRequest,
  OpenCodeSessionDto,
  OpenCodeSessionStateDto,
  OpenCodeValidationDto,
} from '@cql-studio/core';
import { normalizeOpenCodeError, OpenCodeError, openCodeResumeTranscript } from '@cql-studio/core';
import type { OpenCodeEnv } from './config/env.js';
import { loadEnv } from './config/env.js';
import { openCodeLogger } from './logger.js';
import { OpenCodeWorkspaceManager, providerFor, providerIdFor, type MaterializedWorkspace } from './workspace.js';
export { openCodeResumeTranscript } from '@cql-studio/core';

type RuntimeEvent = Event | { type: string; properties: Record<string, unknown> };
type EventListener = (event: OpenCodeEventEnvelope) => void;

const SAFE_NATIVE_TOOLS = new Set(['read', 'glob', 'grep', 'edit', 'question', 'skill']);
const DENIED_NATIVE_TOOLS = new Set([
  'bash', 'write', 'task', 'webfetch', 'websearch', 'apply_patch', 'todowrite',
]);
const EXPECTED_MCP_TOOLS = Object.values(MCPToolNames)
  .filter((name): name is string => typeof name === 'string');
const REQUIRED_MCP_TOOL = MCPToolNames.CQL_VALIDATE;

function matchesMcpToolId(id: string, name: string): boolean {
  return id === name || id.endsWith(`_${name}`);
}

function configuredMcpToolIds(): string[] {
  return EXPECTED_MCP_TOOLS.map(name => `cql-studio_${name}`);
}

export function openCodeMcpToolIds(toolIds: string[]): string[] {
  return toolIds.filter(id => EXPECTED_MCP_TOOLS.some(name => matchesMcpToolId(id, name)));
}

export function safeOpenCodeToolMap(
  toolIds: string[],
  mcpToolIds: string[],
  enabled: boolean
): Record<string, boolean> {
  const mcpTools = new Set(mcpToolIds);
  return Object.fromEntries(toolIds.map(id => [
    id,
    enabled && (SAFE_NATIVE_TOOLS.has(id) || mcpTools.has(id)),
  ]));
}

export function completedDeniedTool(event: Event): string | undefined {
  if (event.type !== 'message.part.updated') return undefined;
  const part = event.properties.part;
  if (part.type !== 'tool' || part.state.status !== 'completed') return undefined;
  return DENIED_NATIVE_TOOLS.has(part.tool) ? part.tool : undefined;
}

interface RuntimeSession {
  dto: OpenCodeSessionDto;
  workspace: MaterializedWorkspace;
  client: OpencodeClient;
  listeners: Set<EventListener>;
  history: OpenCodeEventEnvelope[];
  nextEventId: number;
  eventAbort: AbortController;
  validation: OpenCodeValidationDto | null;
  validationPending: boolean;
  toolBridge?: { baseUrl: string; capability: string };
  stallTimer?: NodeJS.Timeout;
  stallGeneration: number;
  browserRevision: number;
  lastWorkspaceContent: string;
  attachments: Map<string, OpenCodeAttachmentDto>;
  seedMessages: unknown[];
  toolIds: string[];
  mcpToolIds: string[];
}

const CQL_COMMANDS = new Set([
  'validate', 'review', 'explain', 'dependencies', 'library', 'valueset',
  'context', 'fhir', 'research', 'terminology', 'validate-vsac',
]);

/**
 * Only events scoped to this OpenCode session prove that its provider request
 * is making progress. Global events such as server.heartbeat must never keep a
 * stalled request alive indefinitely.
 */
export function isOpenCodeSessionProgress(eventSessionId: unknown, openCodeSessionId: string): boolean {
  return typeof eventSessionId === 'string' && eventSessionId === openCodeSessionId;
}

export function openCodeAttachmentMimeType(converted: boolean): 'text/markdown' | 'text/plain' {
  return converted ? 'text/markdown' : 'text/plain';
}

const LIGHTWEIGHT_CONVERSATION_MESSAGES = new Set([
  'hi',
  'hi there',
  'hello',
  'hello there',
  'hey',
  'hey there',
  'good morning',
  'good afternoon',
  'good evening',
  'how are you',
  'thank you',
  'thanks',
  'who are you',
  'what can you do',
]);

/**
 * Trivial conversation does not need the large IDE and MCP tool schemas. Keep
 * this deliberately conservative so any prompt with working context, an
 * attachment, or an actual request retains the complete OpenCode toolset.
 */
export function isLightweightOpenCodeConversation(input: Pick<OpenCodePromptRequest,
  'message' | 'references' | 'attachments' | 'editorContext'>): boolean {
  if (input.editorContext || input.references?.length || input.attachments?.length) return false;
  const normalized = input.message
    .trim()
    .toLowerCase()
    .replace(/[.!?,;:]+$/u, '')
    .replace(/\s+/g, ' ');
  return LIGHTWEIGHT_CONVERSATION_MESSAGES.has(normalized);
}

/**
 * OpenCode persists a prompt's wildcard tool override for later turns in the
 * same session. Always send the inverse override so a tool-free greeting
 * cannot leave subsequent CQL work without file and MCP tools.
 */
export function openCodeToolsForPrompt(
  input: Pick<OpenCodePromptRequest, 'message' | 'references' | 'attachments' | 'editorContext'>,
  toolIds: string[] = [],
  mcpToolIds: string[] = []
): Record<string, boolean> {
  return safeOpenCodeToolMap(toolIds, mcpToolIds, !isLightweightOpenCodeConversation(input));
}

export class OpenCodeRuntime {
  private readonly env: OpenCodeEnv;
  private readonly workspaces: OpenCodeWorkspaceManager;
  private readonly sessions = new Map<string, RuntimeSession>();
  private server: Awaited<ReturnType<typeof createOpencode>> | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private readonly idleMs: number;
  private readonly cleanupMs: number;
  // Ollama can spend time loading a cold model, but a request must not leave
  // the browser spinning indefinitely when the provider never produces an event.
  // Deployments with slower hardware can override this value explicitly.
  private readonly providerStallMs: number;

  constructor(env: OpenCodeEnv = loadEnv()) {
    this.env = env;
    this.workspaces = new OpenCodeWorkspaceManager(env.workspaceRoot, {
      rewriteLocalhost: env.rewriteLocalhost,
      mcpBridgeBin: env.mcpBridgeBin,
      markitdownBin: env.markitdownBin,
    });
    this.idleMs = env.sessionIdleMs;
    this.cleanupMs = env.cleanupIntervalMs;
    this.providerStallMs = env.providerStallMs;
  }

  private modelFor(session: RuntimeSession): { providerID: string; modelID: string; model: string } {
    const separator = session.dto.model.indexOf('/');
    if (separator < 1) return { providerID: 'ollama', modelID: session.dto.model, model: `ollama/${session.dto.model}` };
    const providerID = session.dto.model.slice(0, separator);
    const modelID = session.dto.model.slice(separator + 1);
    return { providerID, modelID, model: session.dto.model };
  }

  private async refreshToolPolicy(session: RuntimeSession): Promise<void> {
    if (!session.toolBridge) {
      session.toolIds = [];
      session.mcpToolIds = [];
      return;
    }
    const deadline = Date.now() + 15_000;
    let detail = 'CQL Studio MCP did not become ready';
    while (Date.now() < deadline) {
      const status = await session.client.mcp.status();
      const cqlStudio = status.data?.['cql-studio'];
      if (cqlStudio?.status === 'connected') {
        const tools = await session.client.tool.ids();
        const nativeToolIds = tools.data ?? [];
        session.mcpToolIds = configuredMcpToolIds();
        session.toolIds = [...new Set([...nativeToolIds, ...session.mcpToolIds])];
        return;
      }
      if (cqlStudio?.status === 'failed') {
        detail = `CQL Studio MCP failed: ${cqlStudio.error}`;
      } else if (cqlStudio) {
        detail = `CQL Studio MCP status is ${cqlStudio.status}`;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new OpenCodeError('MCP_UNAVAILABLE', detail, 503, true);
  }

  private async requireMcpTools(session: RuntimeSession): Promise<void> {
    const status = await session.client.mcp.status();
    const cqlStudio = status.data?.['cql-studio'];
    if (cqlStudio?.status !== 'connected') {
      const detail = cqlStudio?.status === 'failed' ? `: ${cqlStudio.error}` : '';
      throw new OpenCodeError(
        'MCP_UNAVAILABLE',
        `CQL Studio MCP tools are unavailable${detail}. Check the server tool-bridge URL and restart the session.`,
        503,
        true
      );
    }
    if (!session.mcpToolIds.some(id => matchesMcpToolId(id, REQUIRED_MCP_TOOL))) {
      await this.refreshToolPolicy(session);
    }
  }

  async initialize(): Promise<void> {
    await this.workspaces.initialize();
    if (!this.workspaces.markitdownAvailable()) {
      openCodeLogger.warn(
        { operation: 'runner.markitdown.unavailable' },
        'MarkItDown is unavailable; PDF and DOCX attachments will be rejected until it is installed'
      );
    }
    this.server = await createOpencode({
      hostname: '127.0.0.1',
      port: this.env.internalPort,
      timeout: 20_000,
      config: { autoupdate: false, share: 'disabled', logLevel: 'WARN' },
    });
    this.cleanupTimer = setInterval(() => void this.removeExpired(), this.cleanupMs);
    this.cleanupTimer.unref();
  }

  health(): { healthy: boolean; sessions: number; serverUrl?: string } {
    return { healthy: !!this.server, sessions: this.sessions.size, serverUrl: this.server?.server.url };
  }

  list(): OpenCodeSessionDto[] {
    return [...this.sessions.values()].map(session => session.dto).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async create(input: CreateOpenCodeSessionRequest): Promise<OpenCodeSessionDto> {
    if (!this.server) throw new OpenCodeError('RUNNER_UNAVAILABLE', 'OpenCode runtime is not initialized', 503, true);
    const workspace = await this.workspaces.create(input);
    try {
      const client = createOpencodeClient({
        baseUrl: this.server.server.url,
        directory: workspace.directory,
        throwOnError: true,
      });
      const provider = providerFor(input);
      const providerId = providerIdFor(provider);
      const modelId = provider.model || input.ollamaModel;
      const created = await client.session.create({
        title: input.title || input.activeLibrary.name,
        model: { id: modelId, providerID: providerId, variant: 'fast' },
      });
      const openCodeSession = created.data;
      if (!openCodeSession) throw new Error('OpenCode did not return a session');
      const now = new Date();
      const dto: OpenCodeSessionDto = {
        id: workspace.id,
        openCodeSessionId: openCodeSession.id,
        title: input.title || input.activeLibrary.name,
        status: 'idle',
        activeLibraryId: input.activeLibrary.id,
        activeFile: workspace.activeFile,
        createdAt: input.resume?.createdAt ?? now.toISOString(),
        updatedAt: now.toISOString(),
        lastActivityAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.idleMs).toISOString(),
        model: `${providerId}/${modelId}`,
        reasoningEnabled: false,
      };
      const runtime: RuntimeSession = {
        dto,
        workspace,
        client,
        listeners: new Set(),
        history: [],
        nextEventId: 1,
        eventAbort: new AbortController(),
        validation: null,
        validationPending: false,
        stallGeneration: 0,
        browserRevision: 0,
        lastWorkspaceContent: input.activeLibrary.cqlContent,
        attachments: new Map(),
        toolBridge: input.toolBridge,
        seedMessages: input.resume?.messages ?? [],
        toolIds: [],
        mcpToolIds: [],
      };
      await this.refreshToolPolicy(runtime);
      if (input.resume?.messages.length) {
        await client.session.promptAsync({
          sessionID: openCodeSession.id,
          noReply: true,
          tools: { '*': false },
          parts: [{
            type: 'text',
            text: `<cql-studio-resume-context>\n${openCodeResumeTranscript(input.resume.messages)}\n</cql-studio-resume-context>`,
          }],
        });
      }
      this.sessions.set(dto.id, runtime);
      void this.pumpEvents(runtime);
      openCodeLogger.info({ operation: 'session.create', sessionId: dto.id, activeLibraryId: dto.activeLibraryId }, 'OpenCode session created');
      return dto;
    } catch (error) {
      await this.workspaces.remove(workspace);
      throw error;
    }
  }

  get(id: string): RuntimeSession {
    const session = this.sessions.get(id);
    if (!session) throw new OpenCodeError('SESSION_NOT_FOUND', 'OpenCode session not found', 404, false);
    if (session.dto.status !== 'busy' && Date.parse(session.dto.expiresAt) <= Date.now()) {
      void this.remove(id);
      throw new OpenCodeError('SESSION_EXPIRED', 'OpenCode session expired after 60 minutes of inactivity', 410, false);
    }
    return session;
  }

  async prompt(id: string, input: OpenCodePromptRequest): Promise<void> {
    const session = this.get(id);
    if (input.editorContext && input.editorContext.file !== session.workspace.activeFile) {
      throw new OpenCodeError('INVALID_EDITOR_CONTEXT', 'Editor context does not match the active CQL file', 400, false);
    }
    const lightweightConversation = isLightweightOpenCodeConversation(input);
    if (!lightweightConversation) {
      await this.requireMcpTools(session);
      await this.workspaces.assertWorkspaceIntegrity(session.workspace);
    }
    const ideDiagnostics = lightweightConversation ? undefined : input.ideDiagnostics;
    if (ideDiagnostics && (
      ideDiagnostics.libraryId !== session.dto.activeLibraryId
      || ideDiagnostics.documentRevision !== session.browserRevision
    )) {
      throw new OpenCodeError(
        'STALE_IDE_DIAGNOSTICS',
        'The IDE Problems context does not match the synchronized active CQL document',
        409,
        true
      );
    }
    this.touch(session);
    session.dto.status = 'busy';
    session.dto.reasoningEnabled = Boolean(input.reasoning);
    this.armStallTimer(session);
    const parts: Array<{ type: 'text'; text: string } | FilePartInput> = [{ type: 'text', text: input.message }];
    if (input.editorContext) {
      const context = input.editorContext;
      const selectedText = context.selectedText.slice(0, 50_000);
      parts.push({
        type: 'text',
        text: [
          '',
          `<cql-studio-editor-context mode="${context.mode}" file="${context.file}" revision="${context.documentRevision}" range="${context.startLine}:${context.startColumn}-${context.endLine}:${context.endColumn}">`,
          selectedText,
          '</cql-studio-editor-context>',
          context.mode === 'inline'
            ? 'Limit the requested edit to this selected range (or current line) unless a wider change is required for valid CQL.'
            : 'Treat this editor selection as the user\'s current focus.',
        ].join('\n'),
      });
    }
    if (ideDiagnostics?.diagnostics.length) {
      const diagnostics = ideDiagnostics.diagnostics.slice(0, 100).map(item => ({
        severity: item.severity,
        message: item.message.slice(0, 2_000),
        file: session.workspace.activeFile,
        line: item.line,
        column: item.column,
      }));
      const serialized = JSON.stringify(diagnostics).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
      parts.push({
        type: 'text',
        text: [
          `<cql-studio-problems-context library="${session.dto.activeLibraryId}" revision="${session.browserRevision}">`,
          serialized,
          '</cql-studio-problems-context>',
          'These are the current diagnostics shown in the CQL Studio Problems tab. Use them as the initial repair target, then run cql_validate after editing.',
        ].join('\n'),
      });
    }
    const references = new Set(input.references ?? []);
    if (ideDiagnostics?.diagnostics.length && session.workspace.manifest.files['dependencies/FHIRHelpers.cql']) {
      references.add('dependencies/FHIRHelpers.cql');
    }
    for (const reference of [...references].slice(0, 20)) {
      const absolute = this.workspaces.resolveReference(session.workspace, reference);
      const marker = `@${reference}`;
      const start = Math.max(0, input.message.indexOf(marker));
      parts.push({
        type: 'file',
        mime: 'text/plain',
        filename: reference,
        url: pathToFileURL(absolute).href,
        source: { type: 'file', path: absolute, text: { value: marker, start, end: start + marker.length } },
      });
    }
    for (const attachmentId of [...new Set(input.attachments ?? [])].slice(0, 20)) {
      const attachment = session.attachments.get(attachmentId);
      if (!attachment) {
        session.dto.status = 'error';
        this.clearStallTimer(session);
        throw new OpenCodeError('ATTACHMENT_NOT_FOUND', `Attachment was not found: ${attachmentId}`, 404, false);
      }
      const absolute = path.join(session.workspace.directory, attachment.path);
      parts.push({
        type: 'file',
        // Every accepted non-converted attachment has already been validated
        // and materialized as UTF-8 text. Normalize its provider-facing MIME
        // type so uncommon extensions are not mistaken for binary content.
        mime: openCodeAttachmentMimeType(attachment.converted),
        filename: attachment.converted ? `${attachment.name}.md` : attachment.name,
        url: pathToFileURL(absolute).href,
        source: { type: 'file', path: absolute, text: { value: attachment.name, start: 0, end: attachment.name.length } },
      });
    }
    try {
      const selectedModel = this.modelFor(session);
      await session.client.session.promptAsync({
        sessionID: session.dto.openCodeSessionId,
        agent: input.agent === 'plan' ? 'plan' : 'build',
        model: { providerID: selectedModel.providerID, modelID: selectedModel.modelID },
        variant: input.reasoning ? 'thinking' : 'fast',
        tools: openCodeToolsForPrompt(input, session.toolIds, session.mcpToolIds),
        parts,
      });
      openCodeLogger.info({
        operation: 'prompt.accepted',
        sessionId: id,
        model: selectedModel.model,
        toolsEnabled: !lightweightConversation,
        references: input.references?.length ?? 0,
        attachments: input.attachments?.length ?? 0,
        editorContext: Boolean(input.editorContext),
      }, 'OpenCode prompt accepted');
    } catch (error) {
      session.dto.status = 'error';
      this.clearStallTimer(session);
      throw error;
    }
  }

  async switchModel(id: string, input: OpenCodeModelSwitchRequest): Promise<void> {
    const session = this.get(id);
    if (!input?.provider || typeof input.model !== 'string' || !input.model.trim()) {
      throw new OpenCodeError('INVALID_MODEL', 'A provider and model are required', 400, false);
    }
    const providerId = providerIdFor(input.provider);
    await this.workspaces.ensureProviderModel(session.workspace, input.provider, input.model);
    session.dto.model = `${providerId}/${input.model.trim()}`;
    this.touch(session);
    openCodeLogger.info({ operation: 'session.model.switch', sessionId: id, provider: providerId, model: input.model.trim() }, 'OpenCode model switched');
  }

  async addAttachment(id: string, input: OpenCodeAttachmentUploadRequest): Promise<OpenCodeAttachmentDto> {
    const session = this.get(id);
    if (session.attachments.size >= 20) throw new OpenCodeError('ATTACHMENT_LIMIT_REACHED', 'A session may contain at most 20 attachments', 413, false);
    try {
      const attachment = await this.workspaces.addAttachment(session.workspace, input);
      session.attachments.set(attachment.id, attachment);
      this.touch(session);
      openCodeLogger.info({ operation: 'attachment.add', sessionId: id, attachmentId: attachment.id, name: attachment.name, converted: attachment.converted }, 'OpenCode attachment added');
      return attachment;
    } catch (error) {
      throw new OpenCodeError('INVALID_ATTACHMENT', error instanceof Error ? error.message : String(error), 400, false);
    }
  }

  async removeAttachment(id: string, attachmentId: string): Promise<void> {
    const session = this.get(id);
    const attachment = session.attachments.get(attachmentId);
    if (!attachment) throw new OpenCodeError('ATTACHMENT_NOT_FOUND', 'OpenCode attachment was not found', 404, false);
    await this.workspaces.removeAttachment(session.workspace, attachment);
    session.attachments.delete(attachmentId);
    this.touch(session);
  }

  async executeCommand(id: string, command: string, args = '', reasoning = false): Promise<void> {
    const session = this.get(id);
    const normalized = command.replace(/^\//, '').trim();
    if (!/^[a-z][a-z0-9_-]*$/i.test(normalized)) throw new OpenCodeError('INVALID_COMMAND', 'Command name is invalid', 400);
    this.touch(session);
    session.dto.status = 'busy';
    session.dto.reasoningEnabled = reasoning;
    this.armStallTimer(session);
    try {
      if (normalized !== 'compact') {
        await this.requireMcpTools(session);
        await this.workspaces.assertWorkspaceIntegrity(session.workspace);
      }
      if (normalized === 'compact') {
        const selectedModel = this.modelFor(session);
        this.runDetachedCommand(session, session.client.session.summarize({
          sessionID: session.dto.openCodeSessionId,
          providerID: selectedModel.providerID,
          modelID: selectedModel.modelID,
          auto: false,
        }), normalized, async () => {
          await Promise.all([...session.attachments.values()].map(attachment => this.workspaces.removeAttachment(session.workspace, attachment)));
          session.attachments.clear();
          this.emit(session, { type: 'attachments.compacted', properties: {} });
          openCodeLogger.info({ operation: 'attachment.compact', sessionId: id }, 'OpenCode attachments purged after compaction');
        });
        return;
      }
      const selectedModel = this.modelFor(session);
      const commands = await this.commands(id);
      if (!commands.some(item => item.name === normalized && item.source !== 'web')) {
        throw new OpenCodeError('COMMAND_NOT_FOUND', `OpenCode command was not found: /${normalized}`, 404);
      }
      const attachmentHint = [...session.attachments.values()]
        .map(attachment => `Session attachment: ${attachment.path} (original name: ${attachment.name}). Read it when relevant.`)
        .join('\n');
      const commandArguments = [args.trim(), attachmentHint].filter(Boolean).join('\n\n');
      this.runDetachedCommand(session, session.client.session.command({
        sessionID: session.dto.openCodeSessionId,
        command: normalized,
        arguments: commandArguments,
        agent: 'build',
        model: selectedModel.model,
        variant: reasoning ? 'thinking' : 'fast',
      }), normalized);
    } catch (error) {
      session.dto.status = 'error';
      this.clearStallTimer(session);
      throw error;
    }
  }

  async commands(id: string): Promise<OpenCodeCommandDto[]> {
    const session = this.get(id);
    const result = await session.client.command.list();
    const commands = result.data ?? [];
    return commands
      .filter(command => !command.source || command.source === 'command')
      .filter(command => !['connect', 'models', 'sessions', 'editor', 'init', 'export', 'themes', 'share', 'unshare', 'exit', 'undo', 'redo'].includes(command.name))
      .map(command => ({
        name: command.name,
        description: command.description || `Run /${command.name}`,
        source: CQL_COMMANDS.has(command.name) ? 'cql-studio' as const : 'opencode' as const,
        acceptsArguments: command.template.includes('$ARGUMENTS'),
      }));
  }

  async files(id: string, query = '', limit = 30): Promise<OpenCodeFileReferenceDto[]> {
    const session = this.get(id);
    const allowed = this.workspaces.references(session.workspace, '', 50);
    const allowedByPath = new Map(allowed.map(file => [file.path, file]));
    const result = await session.client.find.files({ query, type: 'file', limit: Math.min(Math.max(limit, 1), 50) });
    const sdkPaths = (result.data ?? []).map(item => typeof item === 'string' ? item : String(item));
    return sdkPaths.map(file => file.replace(/^\.\//, '')).filter(file => allowedByPath.has(file))
      .map(file => allowedByPath.get(file)!)
      .slice(0, limit);
  }

  async messages(id: string): Promise<unknown[]> {
    const session = this.get(id);
    const result = await session.client.session.messages({ sessionID: session.dto.openCodeSessionId });
    return [...session.seedMessages, ...(result.data ?? [])];
  }

  async diff(id: string): Promise<OpenCodeFileDiffDto[]> {
    return this.workspaces.diff(this.get(id).workspace);
  }

  async syncActiveFile(id: string, input: OpenCodeActiveFileSyncRequest): Promise<void> {
    const session = this.get(id);
    if (session.dto.status === 'busy') {
      throw new OpenCodeError('SESSION_BUSY', 'Wait for OpenCode to finish before synchronizing the editor', 409, true);
    }
    if (Buffer.byteLength(input.content, 'utf8') > 1_048_576) {
      throw new OpenCodeError('ACTIVE_FILE_TOO_LARGE', 'The active CQL file exceeds the 1 MiB OpenCode limit', 413, false);
    }
    const contentChanged = input.content !== session.lastWorkspaceContent;
    await this.workspaces.syncActiveFile(session.workspace, input.content);
    session.browserRevision = Math.max(0, Math.trunc(input.documentRevision));
    session.lastWorkspaceContent = input.content;
    if (contentChanged) session.validation = null;
    // Browser content establishes the baseline for the next AI turn. Automatic
    // validation is reserved for changes OpenCode subsequently makes.
    session.validationPending = false;
    this.touch(session);
  }

  async state(id: string): Promise<OpenCodeSessionStateDto> {
    const session = this.get(id);
    const [messages, diffs, commands, permissions, questions] = await Promise.all([
      this.messages(id),
      this.diff(id),
      this.commands(id),
      this.permissions(id),
      this.questions(id),
    ]);
    return {
      session: session.dto,
      messages,
      diffs,
      attachments: [...session.attachments.values()],
      commands,
      validation: session.validation,
      permissions,
      questions,
      lastEventId: session.nextEventId - 1,
    };
  }

  async permissions(id: string): Promise<OpenCodePermissionRequestDto[]> {
    const session = this.get(id);
    const result = await session.client.permission.list();
    return (result.data ?? [])
      .filter(request => request.sessionID === session.dto.openCodeSessionId)
      .map(request => ({
        id: request.id,
        type: request.permission,
        title: `OpenCode requests permission to ${request.permission}`,
        pattern: request.patterns,
        metadata: request.metadata,
      }));
  }

  async questions(id: string): Promise<OpenCodeQuestionRequestDto[]> {
    const session = this.get(id);
    const result = await session.client.question.list();
    return (result.data ?? [])
      .filter(request => request.sessionID === session.dto.openCodeSessionId)
      .map(request => ({ id: request.id, questions: request.questions }));
  }

  async validate(id: string): Promise<OpenCodeValidationDto> {
    const session = this.get(id);
    if (!session.toolBridge) throw new OpenCodeError('VALIDATION_UNAVAILABLE', 'CQL validation bridge is unavailable', 503, true);
    const workspace = await this.workspaces.validationPayload(session.workspace);
    const response = await fetch(`${session.toolBridge.baseUrl.replace(/\/+$/, '')}/execute`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session.toolBridge.capability}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: MCPToolNames.CQL_VALIDATE, arguments: { __workspace: workspace } }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new OpenCodeError('VALIDATION_UNAVAILABLE', `CQL validation failed (${response.status})`, 503, true);
    session.validation = await response.json() as OpenCodeValidationDto;
    session.validationPending = false;
    this.emit(session, { type: 'cql.validation.updated', properties: session.validation as unknown as Record<string, unknown> });
    return session.validation;
  }

  async abort(id: string): Promise<void> {
    const session = this.get(id);
    await session.client.session.abort({ sessionID: session.dto.openCodeSessionId });
    session.dto.status = 'idle';
    this.clearStallTimer(session);
    this.touch(session);
  }

  async permission(id: string, permissionId: string, response: OpenCodePermissionResponse): Promise<void> {
    const session = this.get(id);
    await session.client.permission.reply({ requestID: permissionId, reply: response });
    this.touch(session);
  }

  async answerQuestion(id: string, requestId: string, answers: string[][]): Promise<void> {
    const session = this.get(id);
    await session.client.question.reply({ requestID: requestId, answers });
    this.touch(session);
  }

  async rejectQuestion(id: string, requestId: string): Promise<void> {
    const session = this.get(id);
    await session.client.question.reject({ requestID: requestId });
    this.touch(session);
  }

  subscribe(id: string, listener: EventListener, afterId = 0): () => void {
    const session = this.get(id);
    session.history.filter(envelope => envelope.id > afterId).forEach(listener);
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  }

  async remove(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    session.eventAbort.abort();
    this.clearStallTimer(session);
    await session.client.session.delete({ sessionID: session.dto.openCodeSessionId }).catch(() => undefined);
    await this.workspaces.remove(session.workspace);
    this.sessions.delete(id);
    openCodeLogger.info({ operation: 'session.remove', sessionId: id }, 'OpenCode session removed');
  }

  async removeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map(id => this.remove(id)));
  }

  private touch(session: RuntimeSession): void {
    const now = new Date();
    session.dto.updatedAt = now.toISOString();
    session.dto.lastActivityAt = now.toISOString();
    session.dto.expiresAt = new Date(now.getTime() + this.idleMs).toISOString();
  }

  private emit(session: RuntimeSession, event: RuntimeEvent): void {
    const envelope: OpenCodeEventEnvelope = {
      id: session.nextEventId++,
      sessionId: session.dto.id,
      emittedAt: new Date().toISOString(),
      event: event as OpenCodeEventEnvelope['event'],
    };
    session.history.push(envelope);
    if (session.history.length > 1_000) session.history.shift();
    session.listeners.forEach(listener => listener(envelope));
  }

  private async pumpEvents(session: RuntimeSession): Promise<void> {
    try {
      const subscription = await session.client.event.subscribe({}, { signal: session.eventAbort.signal });
      for await (const event of subscription.stream) {
        const typed = event as Event;
        const properties = typed.properties as Record<string, any>;
        const eventSessionId = properties['sessionID'] ?? properties['info']?.sessionID ?? properties['part']?.sessionID;
        if (eventSessionId && eventSessionId !== session.dto.openCodeSessionId) continue;
        const deniedTool = completedDeniedTool(typed);
        if (deniedTool) {
          session.dto.status = 'error';
          this.clearStallTimer(session);
          openCodeLogger.error(
            { operation: 'tool.policy.violation', sessionId: session.dto.id, tool: deniedTool },
            'OpenCode completed a disabled native tool'
          );
          await session.client.session.abort({ sessionID: session.dto.openCodeSessionId }).catch(() => undefined);
          this.emit(session, {
            type: 'runner.error',
            properties: {
              code: 'TOOL_POLICY_VIOLATION',
              message: `OpenCode attempted a disabled ${deniedTool} tool. The session was stopped.`,
              retryable: false,
            },
          });
          continue;
        }
        if (
          (typed.type === 'file.edited' || typed.type === 'file.watcher.updated') &&
          typeof properties['file'] === 'string'
        ) {
          await this.workspaces.assertWorkspaceIntegrity(session.workspace);
          if (this.workspaces.isActiveFile(session.workspace, properties['file'])) {
            await this.emitWorkspaceChange(session);
          }
        }
        if (typed.type === 'session.status') {
          session.dto.status = properties['status']?.type === 'busy' ? 'busy' : 'idle';
          if (session.dto.status === 'idle') this.clearStallTimer(session);
        } else if (typed.type === 'session.idle') {
          session.dto.status = 'idle';
          this.clearStallTimer(session);
          this.touch(session);
        } else if (typed.type === 'session.error') {
          session.dto.status = 'error';
          this.clearStallTimer(session);
        }
        if (session.dto.status === 'busy' && isOpenCodeSessionProgress(eventSessionId, session.dto.openCodeSessionId)) {
          this.armStallTimer(session);
        }
        this.emit(session, typed);
        if (typed.type === 'session.idle') {
          this.validatePendingWorkspace(session);
        }
      }
    } catch (error) {
      if (session.eventAbort.signal.aborted) return;
      session.dto.status = 'error';
      this.emit(session, {
        type: 'runner.error',
        properties: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  private async emitWorkspaceChange(session: RuntimeSession): Promise<void> {
    const content = await this.workspaces.readActiveFile(session.workspace);
    if (content === session.lastWorkspaceContent) return;
    session.lastWorkspaceContent = content;
    session.validation = null;
    session.validationPending = true;
    this.emit(session, {
      type: 'cql.workspace.changed',
      properties: {
        file: session.workspace.activeFile,
        libraryId: session.dto.activeLibraryId,
        content,
        baseRevision: session.browserRevision,
      },
    });
    if (session.dto.status !== 'busy') this.validatePendingWorkspace(session);
  }

  private validatePendingWorkspace(session: RuntimeSession): void {
    if (!session.validationPending) return;
    // Consume the flag before starting so duplicate OpenCode idle events cannot
    // launch duplicate validation requests for the same edit.
    session.validationPending = false;
    void this.validate(session.dto.id).catch(error => {
      this.emit(session, { type: 'cql.validation.error', properties: { message: error instanceof Error ? error.message : String(error) } });
    });
  }

  private async removeExpired(): Promise<void> {
    const now = Date.now();
    const expired = [...this.sessions.values()]
      .filter(session => session.dto.status !== 'busy' && Date.parse(session.dto.expiresAt) <= now)
      .map(session => session.dto.id);
    await Promise.all(expired.map(id => this.remove(id)));
  }

  private armStallTimer(session: RuntimeSession): void {
    this.clearStallTimer(session);
    const generation = session.stallGeneration;
    session.stallTimer = setTimeout(() => {
      if (session.stallGeneration !== generation || session.dto.status !== 'busy') return;
      this.clearStallTimer(session);
      void session.client.session.abort({ sessionID: session.dto.openCodeSessionId }).catch(() => undefined);
      session.dto.status = 'error';
      this.emit(session, {
        type: 'runner.error',
        properties: {
          code: 'OLLAMA_STALLED',
          message: `The AI provider produced no progress for ${Math.round(this.providerStallMs / 1000)} seconds. The request was stopped; retry after the model finishes loading or increase CQL_STUDIO_OPENCODE_PROVIDER_STALL_MS.`,
          retryable: true,
        },
      });
    }, this.providerStallMs);
    session.stallTimer.unref();
  }

  private clearStallTimer(session: RuntimeSession): void {
    session.stallGeneration += 1;
    if (session.stallTimer) clearTimeout(session.stallTimer);
    session.stallTimer = undefined;
  }

  private runDetachedCommand(session: RuntimeSession, operation: PromiseLike<unknown>, command: string, onSuccess?: () => Promise<void>): void {
    void Promise.resolve(operation).then(async () => {
      if (onSuccess) await onSuccess();
      if (session.dto.status !== 'busy') return;
      session.dto.status = 'idle';
      this.clearStallTimer(session);
      this.touch(session);
      this.emit(session, { type: 'session.status', properties: { status: { type: 'idle' } } });
      this.validatePendingWorkspace(session);
    }).catch(error => {
      const normalized = normalizeOpenCodeError(error);
      session.dto.status = 'error';
      this.clearStallTimer(session);
      this.emit(session, {
        type: 'runner.error',
        properties: {
          code: normalized.code,
          message: `/${command} failed: ${normalized.message}`,
          retryable: normalized.retryable,
        },
      });
    });
  }
}
