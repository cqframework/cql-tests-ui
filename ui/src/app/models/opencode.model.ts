// Author: Preston Lee

import type {
  CreateOpenCodeSessionRequest as CoreCreateOpenCodeSessionRequest,
  OpenCodeAttachmentDto,
  OpenCodeCommandDto,
  OpenCodeDiagnosticDto,
  OpenCodeEditorContext as CoreOpenCodeEditorContext,
  OpenCodeErrorBody,
  OpenCodeEventEnvelope,
  OpenCodeFileDiffDto,
  OpenCodeFileReferenceDto,
  OpenCodeIdeDiagnosticsContext,
  OpenCodePermissionRequestDto,
  OpenCodeProviderConfig,
  OpenCodeQuestionRequestDto,
  OpenCodeSessionDto,
  OpenCodeValidationDto,
  OpenCodeWorkspaceOrigin,
} from '@cql-studio/core';
import { CqlEnvironment } from './environment.model';
import { ActiveEnvironmentSource } from './settings.model';

export type {
  OpenCodeEventEnvelope,
  OpenCodeProviderConfig,
};

export interface OpenCodeEnvironmentBinding {
  key: string;
  source: ActiveEnvironmentSource;
  environmentId: string;
  workspaceId?: string;
  label: string;
  configurationFingerprint: string;
}

export interface OpenCodeLibrarySnapshot {
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

export interface CreateOpenCodeSessionRequest extends Omit<
  CoreCreateOpenCodeSessionRequest,
  'activeLibrary' | 'dependencies' | 'environment' | 'toolContext'
> {
  activeLibrary: OpenCodeLibrarySnapshot;
  dependencies: OpenCodeLibrarySnapshot[];
  environment: CqlEnvironment;
  toolContext: {
    vsacFhirBaseUrl: string;
    vsacApiUsername: string;
    vsacApiPassword: string;
    searxngBaseUrl: string;
  };
}

export interface OpenCodeSession extends OpenCodeSessionDto {
  environmentBinding?: OpenCodeEnvironmentBinding;
}

export type OpenCodeFileDiff = OpenCodeFileDiffDto;

export interface OpenCodeEditorContext extends CoreOpenCodeEditorContext {
  libraryId: string;
}

export type OpenCodeAttachment = OpenCodeAttachmentDto;

export interface OpenCodeLibraryChange {
  libraryId: string;
  cqlContent: string;
  save?: boolean;
  /** The AI review flow already completed the VSAC import gate for this exact content. */
  vsacTerminologyReady?: boolean;
  mode?: 'review' | 'live' | 'revert';
  baseRevision?: number;
  onSaveComplete?: (saved: boolean) => void;
}

export interface OpenCodeEvent {
  type: string;
  properties: Record<string, unknown>;
}

export type OpenCodeCommand = OpenCodeCommandDto;
export type OpenCodeFileReference = OpenCodeFileReferenceDto;
export type OpenCodeDiagnostic = OpenCodeDiagnosticDto;
export type OpenCodeIdeDiagnostics = OpenCodeIdeDiagnosticsContext;
export type OpenCodeValidation = OpenCodeValidationDto;

export interface OpenCodeSessionState {
  libraries?: OpenCodeLibrarySnapshot[];
  files?: OpenCodeFileReference[];
  session: OpenCodeSession;
  messages: unknown[];
  diffs: OpenCodeFileDiff[];
  attachments: OpenCodeAttachment[];
  commands: OpenCodeCommand[];
  validation: OpenCodeValidation | null;
  permissions: OpenCodePermissionRequest[];
  questions: OpenCodeQuestionRequest[];
  lastEventId: number;
}

export interface OpenCodeActivity {
  id: string;
  messageId?: string;
  kind: 'tool' | 'reasoning' | 'step' | 'retry' | 'compaction' | 'validation' | 'repair';
  title: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  detail?: string;
  output?: string;
  startedAt?: number;
  endedAt?: number;
  reasoningTokens?: number;
  order: number;
}

export type OpenCodeApiErrorBody = OpenCodeErrorBody;
export type OpenCodePermissionRequest = OpenCodePermissionRequestDto;
export type OpenCodeQuestionRequest = OpenCodeQuestionRequestDto;

export interface OpenCodeUiMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  order: number;
}
