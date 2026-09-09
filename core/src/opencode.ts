// Author: Preston Lee

import type { WorkspaceRole } from './workspace.js';

export interface OpenCodeWorkspaceOrigin {
  workspaceId: string;
  workspaceName: string;
  resourceReferenceId: string;
  role?: WorkspaceRole | null;
}

export interface OpenCodeLibraryInput {
  id: string;
  name: string;
  version?: string;
  canonicalUrl?: string;
  cqlContent: string;
  originalContent?: string;
  documentRevision?: number;
  fhirVersionId?: string;
  workspaceOrigin?: OpenCodeWorkspaceOrigin;
}

export interface OpenCodeDependencyInput extends OpenCodeLibraryInput {
  system?: string;
}

export type OpenCodeProviderType = 'ollama' | 'openai' | 'openai-compatible';

export interface OpenCodeProviderConfig {
  type: OpenCodeProviderType;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  name?: string;
}

export interface CreateOpenCodeSessionRequest {
  title?: string;
  provider?: OpenCodeProviderConfig;
  providers?: OpenCodeProviderConfig[];
  /** @deprecated retained for clients from before provider selection. */
  ollamaBaseUrl: string;
  /** @deprecated retained for clients from before provider selection. */
  ollamaModel: string;
  activeLibrary: OpenCodeLibraryInput;
  libraries?: OpenCodeLibraryInput[];
  dependencies?: OpenCodeDependencyInput[];
  /** Browser-provided endpoint context retained only in gateway memory. */
  environment?: unknown;
  /** Browser-provided tool credentials retained only in gateway memory. */
  toolContext?: {
    vsacFhirBaseUrl?: string;
    vsacApiUsername?: string;
    vsacApiPassword?: string;
    searxngBaseUrl?: string;
  };
  /** Injected by the trusted gateway. Never accepted from the browser verbatim. */
  toolBridge?: {
    baseUrl: string;
    capability: string;
  };
  /** Injected only by the trusted gateway when an archived session is resumed. */
  resume?: {
    sessionId: string;
    createdAt: string;
    messages: unknown[];
  };
}

export type ResumeOpenCodeSessionRequest = Omit<CreateOpenCodeSessionRequest, 'resume' | 'toolBridge'>;

export interface OpenCodeModelSwitchRequest {
  provider: OpenCodeProviderConfig;
  model: string;
}

export interface OpenCodePromptRequest {
  message: string;
  agent?: 'plan' | 'build';
  references?: string[];
  attachments?: string[];
  reasoning?: boolean;
  editorContext?: OpenCodeEditorContext;
  /** Current diagnostics shown in the IDE Problems tab for the synchronized document. */
  ideDiagnostics?: OpenCodeIdeDiagnosticsContext;
}

export interface OpenCodeIdeDiagnosticsContext {
  libraryId: string;
  documentRevision: number;
  diagnostics: OpenCodeDiagnosticDto[];
}

export interface OpenCodeAttachmentUploadRequest {
  name: string;
  mimeType?: string;
  data: string;
}

export interface OpenCodeAttachmentDto {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  path: string;
  converted: boolean;
  createdAt: string;
}

export interface OpenCodeEditorContext {
  libraryId?: string;
  file: string;
  selectedText: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  documentRevision: number;
  mode: 'selection' | 'inline';
}

export interface OpenCodeActiveFileSyncRequest {
  libraryId?: string;
  content: string;
  documentRevision: number;
}

export interface OpenCodeWorkspaceManifestEntry {
  libraryId: string;
  name: string;
  version?: string;
  canonicalUrl?: string;
  fhirVersionId?: string;
  workspaceOrigin?: OpenCodeWorkspaceOrigin;
  sourceHash: string;
  draft: boolean;
  writable: boolean;
}

export interface OpenCodeWorkspaceManifest {
  schemaVersion: 1;
  sessionId: string;
  createdAt: string;
  activeLibraryId: string;
  files: Record<string, OpenCodeWorkspaceManifestEntry>;
}

export interface OpenCodeSessionDto {
  id: string;
  openCodeSessionId: string;
  title: string;
  status: 'starting' | 'idle' | 'busy' | 'error';
  activeLibraryId: string;
  activeFile: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  expiresAt: string;
  model: string;
  reasoningEnabled: boolean;
  /** Live sessions can accept prompts; archived sessions retain server-backed history only. */
  availability?: 'live' | 'archived';
  workspaceOrigin?: OpenCodeWorkspaceOrigin;
}

export interface OpenCodeFileDiffDto {
  file: string;
  libraryId: string;
  before: string;
  after: string;
  additions: number;
  deletions: number;
}

export interface OpenCodeCommandDto {
  name: string;
  description: string;
  source: 'web' | 'opencode' | 'cql-studio';
  acceptsArguments: boolean;
}

export interface OpenCodeFileReferenceDto {
  path: string;
  libraryId?: string;
  name: string;
  writable: boolean;
}

export interface OpenCodeDiagnosticDto {
  severity: 'error' | 'warning' | 'info';
  message: string;
  file?: string;
  line?: number;
  column?: number;
}

export interface OpenCodeValidationDto {
  valid: boolean;
  diagnostics: OpenCodeDiagnosticDto[];
  checkedAt: string;
}

export interface OpenCodePermissionRequestDto {
  id: string;
  type: string;
  title: string;
  pattern?: string | string[];
  metadata?: Record<string, unknown>;
}

export interface OpenCodeQuestionRequestDto {
  id: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiple?: boolean;
    custom?: boolean;
  }>;
}

export interface OpenCodeSessionStateDto {
  libraries?: OpenCodeLibraryInput[];
  files?: OpenCodeFileReferenceDto[];
  session: OpenCodeSessionDto;
  messages: unknown[];
  diffs: OpenCodeFileDiffDto[];
  attachments: OpenCodeAttachmentDto[];
  commands: OpenCodeCommandDto[];
  validation: OpenCodeValidationDto | null;
  permissions: OpenCodePermissionRequestDto[];
  questions: OpenCodeQuestionRequestDto[];
  lastEventId: number;
}

export interface OpenCodeEventEnvelope {
  id: number;
  sessionId: string;
  emittedAt: string;
  event: { type: string; properties: Record<string, unknown> };
}

export interface OpenCodeErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export type OpenCodePermissionResponse = 'once' | 'always' | 'reject';

export class OpenCodeFileToolNames {
  static readonly CREATE = 'cql_workspace_create';
  static readonly RENAME = 'cql_workspace_rename';
}

export interface OpenCodeFileOperation {
  kind: 'create' | 'rename';
  libraryId: string;
  name: string;
  content: string;
  file: string;
  previousFile?: string;
}

export const openCodeFileTools = [
  {
    name: OpenCodeFileToolNames.CREATE,
    description: 'Create and save a CQL Library in CQL Studio. Waits for user approval when live edits are off. Use this instead of writing unmanaged files.',
    parameters: { type: 'object', properties: { name: { type: 'string' }, content: { type: 'string' } }, required: ['name', 'content'], additionalProperties: false },
  },
  {
    name: OpenCodeFileToolNames.RENAME,
    description: 'Rename a managed CQL file and its Library name. Always waits for user approval. Provide updated CQL content including the new library declaration.',
    parameters: { type: 'object', properties: { file: { type: 'string' }, name: { type: 'string' }, content: { type: 'string' } }, required: ['file', 'name', 'content'], additionalProperties: false },
  },
];
