// Author: Preston Lee

import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, OnInit, ViewChild, computed, effect, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MarkdownComponent } from 'ngx-markdown';
import {
  OpenCodeActivity,
  OpenCodeAttachment,
  OpenCodeCommand,
  OpenCodeEvent,
  OpenCodeEventEnvelope,
  OpenCodeEditorContext,
  OpenCodeFileDiff,
  OpenCodeFileReference,
  OpenCodeLibrarySnapshot,
  OpenCodeLibraryChange,
  OpenCodePermissionRequest,
  OpenCodeQuestionRequest,
  OpenCodeSession,
  OpenCodeSessionState,
  OpenCodeUiMessage,
  OpenCodeValidation,
  OpenCodeIdeDiagnostics,
  CreateOpenCodeSessionRequest,
} from '../../../../models/opencode.model';
import { IdeStateService } from '../../../../services/ide-state.service';
import { OpenCodeApiError, OpenCodeService } from '../../../../services/opencode.service';
import { SettingsService } from '../../../../services/settings.service';
import { OpenCodeEditorBridgeService } from '../../../../services/opencode-editor-bridge.service';
import { LibraryResource } from '../../shared/ide-types';
import type { AiProviderType } from '../../../../models/settings.model';
import { Subscription, timer } from 'rxjs';
import { extractVsacCanonicalUrls, OpenCodeVsacImportService } from '../../../../services/opencode-vsac-import.service';
import { buildOpenCodeProblemsContext } from '../../../../services/opencode-problems-context.lib';

type OpenCodeTimelineItem =
  | { kind: 'message'; id: string; order: number; message: OpenCodeUiMessage }
  | { kind: 'activity'; id: string; order: number; activity: OpenCodeActivity };

interface OpenCodeCommandArgumentHelp {
  name: string;
  usage: string;
  description: string;
  hint: string;
  options: string[];
}

const WEB_COMMANDS: OpenCodeCommand[] = [
  { name: 'help', description: 'Show supported OpenCode web commands', source: 'web', acceptsArguments: false },
  { name: 'new', description: 'Start a new workspace for the active library', source: 'web', acceptsArguments: false },
  { name: 'resume', description: 'Resume a saved session for the active library', source: 'web', acceptsArguments: false },
  { name: 'details', description: 'Toggle detailed tool input and output', source: 'web', acceptsArguments: false },
  { name: 'thinking', description: 'Toggle display of reasoning content', source: 'web', acceptsArguments: false },
  { name: 'model', description: 'Switch the active provider model, or list available models', source: 'web', acceptsArguments: true },
  { name: 'provider', description: 'Switch between Ollama, OpenAI, and the configured compatible provider', source: 'web', acceptsArguments: true },
  { name: 'compact', description: 'Compact this OpenCode session', source: 'opencode', acceptsArguments: false },
];

const MAX_EVENT_RECONNECT_ATTEMPTS = 6;

@Component({
  selector: 'app-ai-tab',
  imports: [FormsModule, MarkdownComponent],
  templateUrl: './ai-tab.component.html',
  styleUrls: ['./ai-tab.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AiTabComponent implements OnInit, OnDestroy {
  readonly applyLibraryChange = output<OpenCodeLibraryChange>();

  @ViewChild('messageScroller') private messageScroller?: ElementRef<HTMLDivElement>;
  @ViewChild('helpCard') private helpCard?: ElementRef<HTMLElement>;
  @ViewChild('promptInput') private promptInput?: ElementRef<HTMLTextAreaElement>;

  private readonly ideStateService = inject(IdeStateService);
  readonly settingsService = inject(SettingsService);
  private readonly openCodeService = inject(OpenCodeService);
  private readonly editorBridge = inject(OpenCodeEditorBridgeService);
  private readonly vsacImport = inject(OpenCodeVsacImportService);
  private readonly messageRoles = new Map<string, 'user' | 'assistant'>();
  private readonly messageOrders = new Map<string, number>();
  private readonly messageParts = new Map<string, Map<string, string>>();
  private readonly activityParts = new Map<string, OpenCodeActivity>();
  private eventSource: EventSource | null = null;
  private reconnectSubscription: Subscription | null = null;
  private reconnectAttempts = 0;
  private lastEventId = 0;
  private repairInFlight = false;
  private timelineSequence = 0;
  private lastInlineRequestId = 0;
  private readonly liveBaselines = new Map<string, string>();
  private readonly savedDiffFiles = signal<Set<string>>(new Set());
  private readonly savingDiffFiles = signal<Set<string>>(new Set());
  private readonly selectedModels = new Map<AiProviderType, string>();
  private commandHelpKey = '';
  private commandHelpRequest = 0;
  private staleSessionAbortId: string | null = null;
  private readonly autoSendInlineRequest = signal(false);

  readonly session = signal<OpenCodeSession | null>(null);
  readonly resumeSessions = signal<OpenCodeSession[]>([]);
  readonly messages = signal<OpenCodeUiMessage[]>([]);
  readonly activities = signal<OpenCodeActivity[]>([]);
  readonly diffs = signal<OpenCodeFileDiff[]>([]);
  readonly validation = signal<OpenCodeValidation | null>(null);
  readonly permissions = signal<OpenCodePermissionRequest[]>([]);
  readonly questions = signal<OpenCodeQuestionRequest[]>([]);
  readonly questionAnswers = signal<Record<string, string[][]>>({});
  readonly commands = signal<OpenCodeCommand[]>(WEB_COMMANDS);
  readonly fileSuggestions = signal<OpenCodeFileReference[]>([]);
  readonly attachments = signal<OpenCodeAttachment[]>([]);
  readonly uploadingAttachments = signal(false);
  readonly promptText = signal('');
  readonly agent = signal<'plan' | 'build'>('build');
  readonly status = signal<'idle' | 'starting' | 'busy' | 'error'>('idle');
  readonly error = signal<string | null>(null);
  readonly errorRetryable = signal(false);
  readonly streamConnected = signal(false);
  readonly reconnectExhausted = signal(false);
  readonly detailsShown = signal(false);
  readonly reasoningShown = signal(false);
  readonly reasoningEnabled = signal(false);
  readonly activeProvider = signal<AiProviderType>('ollama');
  readonly liveEditsEnabled = signal(false);
  readonly liveConflict = signal<string | null>(null);
  readonly inlineContext = signal<OpenCodeEditorContext | null>(null);
  readonly showHelp = signal(false);
  readonly showResumeSessions = signal(false);
  readonly repairAttempts = signal(0);
  readonly commandArgumentHelp = signal<OpenCodeCommandArgumentHelp | null>(null);
  readonly commandHelpLoading = signal(false);
  readonly commandHelpError = signal<string | null>(null);
  readonly timeline = computed<OpenCodeTimelineItem[]>(() => this.orderTimeline([
    ...this.messages().map(message => ({ kind: 'message' as const, id: message.id, order: message.order, message })),
    ...this.activities().map(activity => ({ kind: 'activity' as const, id: activity.id, order: activity.order, activity })),
  ].sort((left, right) => left.order - right.order)));

  readonly isAvailable = computed(() => this.openCodeService.isAvailable());
  readonly activeLibrary = computed(() => this.ideStateService.getActiveLibraryResource());
  readonly canStart = computed(() => {
    const library = this.activeLibrary();
    return this.isAvailable() && Boolean(library) && !library?.contentLoading && !library?.contentLoadError
      && Boolean(this.contentForLibrary(library!).trim()) && this.status() !== 'starting';
  });
  readonly sessionArchived = computed(() => this.session()?.availability === 'archived');
  readonly environmentStale = computed(() => {
    const session = this.session();
    return Boolean(session) && !this.sessionArchived() && !this.openCodeService.isSessionEnvironmentCurrent(session);
  });
  readonly sessionEnvironmentLabel = computed(() =>
    this.session()?.environmentBinding?.label ?? 'Unknown environment'
  );
  readonly currentEnvironmentLabel = computed(() =>
    this.openCodeService.currentEnvironmentBinding().label
  );
  readonly canSend = computed(() => Boolean(this.session())
    && (!this.sessionArchived() || /^\/(?:resume|help|new|details|thinking)\b/i.test(this.promptText().trim()))
    && !this.environmentStale()
    && this.promptText().trim().length > 0
    && this.status() !== 'busy');
  readonly visibleCommands = computed(() => {
    const match = this.promptText().match(/^\/([a-z0-9_-]*)$/i);
    if (!match) return [];
    const query = match[1].toLowerCase();
    return this.commands().filter(command => command.name.toLowerCase().includes(query)).slice(0, 24);
  });
  readonly hasValidationErrors = computed(() => Boolean(this.validation()?.diagnostics.some(item => item.severity === 'error')));
  readonly canApplyAndSave = computed(() => !this.sessionArchived()
    && Boolean(this.validation()?.valid)
    && !this.environmentStale());
  readonly selectedContext = computed<OpenCodeEditorContext | null>(() => {
    const selection = this.editorBridge.selection();
    const active = this.activeLibrary();
    const session = this.session();
    if (!selection || !active || !session || selection.libraryId !== active.id || session.activeLibraryId !== active.id) return null;
    return { ...selection, file: session.activeFile };
  });

  constructor() {
    effect(() => {
      const request = this.editorBridge.inlineRequest();
      if (!request || request.id === this.lastInlineRequestId) return;
      this.lastInlineRequestId = request.id;
      queueMicrotask(() => void this.handleInlineRequest(request));
    });

    effect(() => {
      const shouldSend = this.autoSendInlineRequest();
      const session = this.session();
      const status = this.status();
      if (!shouldSend || !session || status !== 'idle' || this.environmentStale()) return;
      queueMicrotask(() => {
        if (!this.autoSendInlineRequest()) return;
        this.autoSendInlineRequest.set(false);
        void this.sendPrompt();
      });
    });

    effect(() => {
      const session = this.session();
      if (!session || !this.environmentStale()) {
        this.staleSessionAbortId = null;
        return;
      }
      this.liveEditsEnabled.set(false);
      this.inlineContext.set(null);
      if (this.staleSessionAbortId === session.id) {
        return;
      }
      this.staleSessionAbortId = session.id;
      if (this.status() === 'busy') {
        void this.openCodeService.abort(session.id).then(() => {
          if (this.session()?.id === session.id) {
            this.status.set('idle');
          }
        }).catch(error => this.setError(error));
      }
    });
  }

  private async handleInlineRequest(request: {
    context: OpenCodeEditorContext;
    prompt?: string;
    autoSend: boolean;
  }): Promise<void> {
    let session = this.session();
    if (request.autoSend && (
      !session ||
      session.activeLibraryId !== request.context.libraryId ||
      this.status() === 'error' ||
      this.environmentStale()
    )) {
      await this.startSession();
      session = this.session();
    }

    this.inlineContext.set({ ...request.context, file: session?.activeFile ?? '' });
    if (request.prompt) this.promptText.set(request.prompt);

    if (request.autoSend && session?.activeLibraryId === request.context.libraryId) {
      this.autoSendInlineRequest.set(true);
      return;
    }
    this.promptInput?.nativeElement.focus();
  }

  ngOnInit(): void {
    this.liveEditsEnabled.set(this.settingsService.settings().autoApplyCodeEdits);
    this.activeProvider.set(this.settingsService.getEffectiveAiProvider());
    this.selectedModels.set('ollama', this.settingsService.getEffectiveOllamaModel());
    this.selectedModels.set('openai', this.settingsService.getEffectiveOpenAiModel());
    this.selectedModels.set('openai-compatible', this.settingsService.getEffectiveCompatibleProviderModel());
    queueMicrotask(() => void this.restoreSession());
  }

  ngOnDestroy(): void {
    this.eventSource?.close();
    this.reconnectSubscription?.unsubscribe();
  }

  async startSession(): Promise<void> {
    const active = this.activeLibrary();
    if (!active) {
      this.error.set('Open or create a CQL library before starting OpenCode.');
      return;
    }
    if (active.contentLoading) {
      this.error.set('Wait for the active library CQL to finish loading before starting OpenCode.');
      return;
    }
    if (active.contentLoadError) {
      this.error.set(`The active library CQL could not be loaded: ${active.contentLoadError}`);
      return;
    }
    const cqlContent = this.contentForLibrary(active);
    if (!cqlContent.trim()) {
      this.error.set('The active library has no CQL content. Open or create a CQL library, then try again.');
      return;
    }
    // Settings can be changed while the IDE/AI tab remains mounted. Refresh the
    // provider signal here so a stale tab selection cannot submit (for example)
    // an empty compatible-provider config after the user switched back to Ollama.
    const configuredProvider = this.settingsService.getEffectiveAiProvider();
    this.activeProvider.set(configuredProvider);
    const provider = this.providerConfig(configuredProvider);
    if (!provider.model?.trim()) {
      this.error.set(`Choose a model for the ${provider.type} provider in Settings before starting OpenCode.`);
      return;
    }
    if (provider.type !== 'openai' && !provider.baseUrl?.trim()) {
      this.error.set(`Enter a base URL for the ${provider.type} provider in Settings before starting OpenCode.`);
      return;
    }
    this.resetConversation();
    this.status.set('starting');
    try {
      const session = await this.openCodeService.createSession(await this.sessionRequest(active, cqlContent, provider));
      this.session.set(session);
      this.activeProvider.set(this.settingsService.getEffectiveAiProvider());
      this.status.set(session.status === 'error' ? 'error' : 'idle');
      await this.loadCommandsAndFiles();
      this.connectEvents(session.id);
    } catch (error) {
      this.setError(error);
    }
  }

  private providerConfig(provider = this.activeProvider()) {
    if (provider === 'openai') {
      return {
        type: provider,
        model: this.settingsService.getEffectiveOpenAiModel(),
        apiKey: this.settingsService.getEffectiveOpenAiApiKey() || undefined,
      } as const;
    }
    if (provider === 'openai-compatible') {
      return {
        type: provider,
        model: this.settingsService.getEffectiveCompatibleProviderModel(),
        baseUrl: this.settingsService.getEffectiveCompatibleProviderBaseUrl(),
        apiKey: this.settingsService.getEffectiveCompatibleProviderApiKey() || undefined,
        name: this.settingsService.getEffectiveCompatibleProviderName(),
      } as const;
    }
    return {
      type: 'ollama' as const,
      model: this.settingsService.getEffectiveOllamaModel(),
      baseUrl: this.settingsService.getEffectiveOllamaBaseUrl(),
      apiKey: this.settingsService.getEffectiveOllamaApiKey() || undefined,
    };
  }

  private allProviderConfigs() {
    const providers = [this.providerConfig('ollama'), this.providerConfig('openai')];
    const compatible = this.providerConfig('openai-compatible');
    if (compatible.baseUrl) providers.push(compatible);
    return providers;
  }

  private async sessionRequest(
    active: LibraryResource,
    cqlContent: string,
    provider = this.providerConfig()
  ): Promise<CreateOpenCodeSessionRequest> {
    return {
      title: `${active.name} in CQL Studio`,
      provider,
      providers: this.allProviderConfigs(),
      ollamaBaseUrl: this.settingsService.getEffectiveOllamaBaseUrl(),
      ollamaModel: this.settingsService.getEffectiveOllamaModel(),
      activeLibrary: { ...this.snapshot(active), cqlContent },
      dependencies: await this.collectDependencies(active, cqlContent),
      environment: this.settingsService.getEffectiveActiveEnvironment(),
      toolContext: {
        vsacFhirBaseUrl: this.settingsService.getEffectiveVsacFhirBaseUrl(),
        vsacApiUsername: this.settingsService.getEffectiveVsacApiUsername(),
        vsacApiPassword: this.settingsService.getEffectiveVsacApiPassword(),
        searxngBaseUrl: this.settingsService.getEffectiveSearxngBaseUrl(),
      },
    };
  }

  async openResumePicker(): Promise<void> {
    const active = this.activeLibrary();
    if (!active) {
      this.error.set('Open the CQL Library whose session you want to resume.');
      return;
    }
    try {
      const sessions = await this.openCodeService.listSessions();
      this.resumeSessions.set(sessions.filter(item =>
        item.availability === 'archived' && item.activeLibraryId === active.id
      ));
      this.showResumeSessions.set(true);
      this.error.set(null);
    } catch (error) {
      this.setError(error);
    }
  }

  async resumeSession(saved: OpenCodeSession): Promise<void> {
    const active = this.activeLibrary();
    if (!active || saved.activeLibraryId !== active.id) {
      this.error.set('Open the CQL Library associated with this saved session before resuming it.');
      return;
    }
    const cqlContent = this.contentForLibrary(active);
    if (!cqlContent.trim()) {
      this.error.set('The active Library has no CQL content to restore into a live workspace.');
      return;
    }
    const provider = this.providerConfig(this.settingsService.getEffectiveAiProvider());
    this.status.set('starting');
    this.error.set(null);
    try {
      const resumed = await this.openCodeService.resumeSession(
        saved.id,
        await this.sessionRequest(active, cqlContent, provider)
      );
      this.showResumeSessions.set(false);
      await this.attachSession(resumed);
    } catch (error) {
      this.setError(error);
    }
  }

  async attachSession(session: OpenCodeSession): Promise<void> {
    this.showResumeSessions.set(false);
    this.resetConversation();
    this.status.set('starting');
    this.activeProvider.set(session.model.startsWith('openai/') ? 'openai' : session.model.startsWith('ollama/') ? 'ollama' : 'openai-compatible');
    try {
      const state = await this.openCodeService.getState(session.id);
      this.hydrate(state);
      if (state.session.availability !== 'archived') {
        this.connectEvents(session.id);
      } else {
        this.streamConnected.set(false);
      }
    } catch (error) {
      this.setError(error);
    }
  }

  async sendPrompt(): Promise<void> {
    const session = this.session();
    const message = this.promptText().trim();
    if (!session || !message || this.status() === 'busy' || this.environmentStale()) return;

    if (message.startsWith('/')) {
      await this.runSlashCommand(message);
      return;
    }
    const editorContext = this.contextForPrompt(session);
    const promptMessage = editorContext?.mode === 'inline'
      ? `Make a focused edit to the selected CQL range. User request: ${message}`
      : message;
    this.promptText.set('');
    this.fileSuggestions.set([]);
    this.error.set(null);
    this.repairAttempts.set(0);
    this.status.set('busy');
    try {
      await this.syncActiveEditor(session);
      await this.openCodeService.prompt(
        session.id,
        promptMessage,
        this.agent(),
        this.referencesFrom(message),
        this.reasoningEnabled(),
        editorContext ?? undefined,
        this.attachments().map(attachment => attachment.id),
        this.problemsContext(session)
      );
      if (editorContext?.mode === 'inline') this.inlineContext.set(null);
    } catch (error) {
      this.setError(error);
    }
  }

  onPromptChanged(value: string): void {
    this.promptText.set(value);
    this.refreshCommandArgumentHelp(value);
    const match = value.match(/@([A-Za-z0-9._\/-]*)$/);
    const session = this.session();
    if (!match || !session) {
      this.fileSuggestions.set([]);
      return;
    }
    void this.openCodeService.findFiles(session.id, match[1]).then(files => this.fileSuggestions.set(files)).catch(() => {
      this.fileSuggestions.set([]);
    });
  }

  chooseCommand(command: OpenCodeCommand): void {
    this.showHelp.set(false);
    const next = `/${command.name}${command.acceptsArguments ? ' ' : ''}`;
    this.promptText.set(next);
    this.refreshCommandArgumentHelp(next);
  }

  chooseCommandArgument(option: string): void {
    const match = this.promptText().match(/^\/([a-z0-9_-]+)/i);
    if (!match) return;
    const next = `/${match[1]} ${option} `;
    this.promptText.set(next);
    this.refreshCommandArgumentHelp(next);
    this.promptInput?.nativeElement.focus();
  }

  chooseFile(file: OpenCodeFileReference): void {
    this.promptText.update(value => value.replace(/@[A-Za-z0-9._\/-]*$/, `@${file.path} `));
    this.fileSuggestions.set([]);
  }

  async onAttachmentsSelected(event: Event): Promise<void> {
    const session = this.session();
    const input = event.target as HTMLInputElement | null;
    const files = input?.files ? [...input.files] : [];
    if (!session || !files.length) return;
    this.uploadingAttachments.set(true);
    try {
      for (const file of files) {
        try {
          const attachment = await this.openCodeService.uploadAttachment(session.id, file);
          this.attachments.update(current => [...current, attachment]);
        } catch (error) {
          this.setError(error);
        }
      }
    } finally {
      this.uploadingAttachments.set(false);
      if (input) input.value = '';
    }
  }

  async removeAttachment(attachment: OpenCodeAttachment): Promise<void> {
    const session = this.session();
    if (!session) return;
    try {
      await this.openCodeService.removeAttachment(session.id, attachment.id);
      this.attachments.update(current => current.filter(item => item.id !== attachment.id));
    } catch (error) {
      this.setError(error);
    }
  }

  onPromptKeydown(event: KeyboardEvent): void {
    if (event.key === 'Tab') {
      const command = this.visibleCommands()[0];
      const option = this.commandArgumentHelp()?.options[0];
      if (command || option) {
        event.preventDefault();
        if (command) this.chooseCommand(command);
        else this.chooseCommandArgument(option!);
        return;
      }
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void this.sendPrompt();
    }
  }

  async stop(): Promise<void> {
    const session = this.session();
    if (!session) return;
    try {
      await this.openCodeService.abort(session.id);
      this.status.set('idle');
      await this.refreshDiff();
    } catch (error) {
      this.setError(error);
    }
  }

  async refreshDiff(): Promise<void> {
    const session = this.session();
    if (!session) return;
    try {
      this.diffs.set(await this.openCodeService.getDiff(session.id));
    } catch (error) {
      this.setError(error);
    }
  }

  async refreshValidation(): Promise<void> {
    const session = this.session();
    if (!session) return;
    try {
      await this.processValidation(await this.openCodeService.validate(session.id));
    } catch (error) {
      this.setError(error);
    }
  }

  async applyAndSave(diff: OpenCodeFileDiff): Promise<void> {
    const session = this.session();
    if (!session || this.environmentStale()) return;
    this.savingDiffFiles.update(files => new Set(files).add(diff.file));
    try {
      const result = await this.openCodeService.validate(session.id);
      this.validation.set(result);
      if (!result.valid) {
        this.error.set('Apply & save is blocked until all CQL validation errors are fixed.');
        return;
      }
      const vsacReferences = extractVsacCanonicalUrls(diff.after);
      if (vsacReferences.length > 0) {
        const activityId = `vsac-import-${Date.now()}`;
        this.upsertActivity({
          id: activityId,
          kind: 'tool',
          title: `Preparing ${vsacReferences.length} VSAC ValueSet${vsacReferences.length === 1 ? '' : 's'}`,
          status: 'running',
          detail: `Checking the configured terminology endpoint before saving ${diff.file}`,
          startedAt: Date.now(),
        }, true);
        try {
          const summary = await this.vsacImport.importForCql(diff.after);
          this.upsertActivity({
            id: activityId,
            kind: 'tool',
            title: 'VSAC terminology ready',
            status: 'completed',
            detail: `${summary.imported} imported · ${summary.alreadyPresent} already present · ${summary.target}`,
            startedAt: Date.now(),
            endedAt: Date.now(),
          });
        } catch (error) {
          this.upsertActivity({
            id: activityId,
            kind: 'tool',
            title: 'VSAC terminology import failed',
            status: 'error',
            detail: error instanceof Error ? error.message : String(error),
            endedAt: Date.now(),
          });
          throw error;
        }
      }
      this.applyLibraryChange.emit({
        libraryId: diff.libraryId,
        cqlContent: diff.after,
        save: true,
        vsacTerminologyReady: vsacReferences.length > 0,
        onSaveComplete: saved => {
          if (saved) this.savedDiffFiles.update(files => new Set(files).add(diff.file));
        },
      });
    } catch (error) {
      this.setError(error);
    } finally {
      this.savingDiffFiles.update(files => {
        const next = new Set(files);
        next.delete(diff.file);
        return next;
      });
    }
  }

  vsacReferenceCount(diff: OpenCodeFileDiff): number {
    return extractVsacCanonicalUrls(diff.after).length;
  }

  applyLocally(diff: OpenCodeFileDiff): void {
    if (this.environmentStale()) return;
    this.applyLibraryChange.emit({ libraryId: diff.libraryId, cqlContent: diff.after, save: false, mode: 'review' });
    this.diffs.update(diffs => diffs.filter(candidate => candidate.file !== diff.file));
    this.liveBaselines.delete(diff.file);
    this.savedDiffFiles.update(files => { const next = new Set(files); next.delete(diff.file); return next; });
    const session = this.session();
    const revision = this.editorBridge.document()?.userRevision ?? 0;
    if (session) void this.openCodeService.syncActiveFile(session.id, diff.after, revision).catch(error => this.setError(error));
  }

  async revertChange(diff: OpenCodeFileDiff): Promise<void> {
    const session = this.session();
    if (!session || this.environmentStale()) return;
    const revision = this.editorBridge.document()?.userRevision ?? 0;
    this.applyLibraryChange.emit({ libraryId: diff.libraryId, cqlContent: diff.before, save: false, mode: 'revert' });
    try {
      await this.openCodeService.syncActiveFile(session.id, diff.before, revision);
      this.diffs.update(items => items.filter(item => item.file !== diff.file));
      this.validation.set(null);
      this.liveBaselines.delete(diff.file);
      this.savedDiffFiles.update(files => { const next = new Set(files); next.delete(diff.file); return next; });
    } catch (error) {
      this.setError(error);
    }
  }

  async discardChange(diff: OpenCodeFileDiff): Promise<void> {
    const session = this.session();
    const document = this.editorBridge.document();
    const active = this.activeLibrary();
    if (!session || !active || this.environmentStale()) return;
    const content = document?.libraryId === active.id ? document.content : active.cqlContent;
    const revision = document?.libraryId === active.id ? document.userRevision : 0;
    try {
      await this.openCodeService.syncActiveFile(session.id, content, revision);
      this.diffs.update(items => items.filter(item => item.file !== diff.file));
      this.validation.set(null);
      this.liveBaselines.delete(diff.file);
      this.savedDiffFiles.update(files => { const next = new Set(files); next.delete(diff.file); return next; });
    } catch (error) {
      this.setError(error);
    }
  }

  toggleLiveEdits(enabled: boolean): void {
    if (this.environmentStale()) return;
    this.liveEditsEnabled.set(enabled);
    this.liveConflict.set(null);
    this.settingsService.patchSettings({ autoApplyCodeEdits: enabled });
  }

  wasLiveApplied(file: string): boolean {
    return this.liveBaselines.has(file);
  }

  isDiffSaved(file: string): boolean {
    return this.savedDiffFiles().has(file);
  }

  isDiffSaving(file: string): boolean {
    return this.savingDiffFiles().has(file);
  }

  clearInlineContext(): void {
    this.inlineContext.set(null);
  }

  async respondToPermission(permission: OpenCodePermissionRequest, response: 'once' | 'always' | 'reject'): Promise<void> {
    const session = this.session();
    if (!session) return;
    try {
      await this.openCodeService.respondToPermission(session.id, permission.id, response);
      this.permissions.update(items => items.filter(item => item.id !== permission.id));
    } catch (error) {
      this.setError(error);
    }
  }

  toggleQuestionAnswer(request: OpenCodeQuestionRequest, index: number, label: string, multiple = false): void {
    this.questionAnswers.update(current => {
      const answers = (current[request.id] ?? request.questions.map(() => [])).map(answer => [...answer]);
      if (multiple) {
        answers[index] = answers[index].includes(label)
          ? answers[index].filter(item => item !== label)
          : [...answers[index], label];
      } else {
        answers[index] = [label];
      }
      return { ...current, [request.id]: answers };
    });
  }

  questionOptionSelected(requestId: string, index: number, label: string): boolean {
    return Boolean(this.questionAnswers()[requestId]?.[index]?.includes(label));
  }

  canAnswerQuestion(request: OpenCodeQuestionRequest): boolean {
    const answers = this.questionAnswers()[request.id] ?? [];
    return request.questions.every((_question, index) => Boolean(answers[index]?.length));
  }

  async submitQuestion(request: OpenCodeQuestionRequest): Promise<void> {
    const session = this.session();
    const answers = this.questionAnswers()[request.id];
    if (!session || !answers || !this.canAnswerQuestion(request)) return;
    try {
      await this.openCodeService.answerQuestion(session.id, request.id, answers);
      this.removeQuestion(request.id);
    } catch (error) {
      this.setError(error);
    }
  }

  async rejectQuestion(request: OpenCodeQuestionRequest): Promise<void> {
    const session = this.session();
    if (!session) return;
    try {
      await this.openCodeService.rejectQuestion(session.id, request.id);
      this.removeQuestion(request.id);
    } catch (error) {
      this.setError(error);
    }
  }

  async endSession(): Promise<void> {
    const session = this.session();
    if (!session) return;
    try {
      await this.openCodeService.endSession(session.id);
      this.eventSource?.close();
      this.eventSource = null;
      this.resetConversation();
      this.session.set(null);
      this.status.set('idle');
    } catch (error) {
      this.setError(error);
    }
  }

  async retryConnection(): Promise<void> {
    const session = this.session();
    if (!session) return void this.restoreSession();
    await this.attachSession(session);
  }

  activityDuration(activity: OpenCodeActivity): string {
    if (!activity.startedAt) return '';
    const end = activity.endedAt ?? Date.now();
    return `${Math.max(0, (end - activity.startedAt) / 1000).toFixed(1)}s`;
  }

  private async restoreSession(): Promise<void> {
    if (!this.isAvailable()) return;
    const active = this.activeLibrary();
    try {
      const sessions = await this.openCodeService.listSessions();
      this.resumeSessions.set(sessions.filter(item => item.availability === 'archived' && (!active || item.activeLibraryId === active.id)));
      // The IDE's open-library state is not persisted across a full browser reload.
      // Reattach the newest owned session in that case so the conversation and diff
      // remain recoverable while the user reopens the matching Library.
      const matching = active ? sessions.find(session => session.activeLibraryId === active.id) : sessions[0];
      if (matching) await this.attachSession(matching);
    } catch (error) {
      this.setError(error);
    }
  }

  private async loadCommandsAndFiles(): Promise<void> {
    const session = this.session();
    if (!session) return;
    const [commands] = await Promise.all([
      this.openCodeService.getCommands(session.id),
      this.openCodeService.findFiles(session.id, ''),
    ]);
    const names = new Set(WEB_COMMANDS.map(command => command.name));
    this.commands.set([...WEB_COMMANDS, ...commands.filter(command => !names.has(command.name))]);
  }

  private refreshCommandArgumentHelp(value: string): void {
    const match = value.match(/^\/([a-z0-9_-]+)\s*$/i);
    if (!match) {
      this.commandHelpKey = '';
      this.commandHelpRequest += 1;
      this.commandHelpLoading.set(false);
      this.commandHelpError.set(null);
      this.commandArgumentHelp.set(null);
      return;
    }

    const name = match[1].toLowerCase();
    const command = this.commands().find(item => item.name.toLowerCase() === name);
    if (!command) {
      this.commandHelpKey = '';
      this.commandHelpRequest += 1;
      this.commandHelpLoading.set(false);
      this.commandHelpError.set(null);
      this.commandArgumentHelp.set(null);
      return;
    }

    const baseHelp = (options: string[] = []): OpenCodeCommandArgumentHelp => ({
      name: command.name,
      usage: command.acceptsArguments ? `/${command.name} <arguments>` : `/${command.name}`,
      description: command.description,
      hint: command.acceptsArguments ? 'Add an argument after the command.' : 'No arguments are required.',
      options,
    });

    if (name === 'provider') {
      const options = this.providerCommandOptions();
      this.commandHelpKey = `provider:${options.join(',')}`;
      this.commandHelpRequest += 1;
      this.commandHelpLoading.set(false);
      this.commandHelpError.set(null);
      this.commandArgumentHelp.set({
        ...baseHelp(options),
        usage: '/provider <provider>',
        hint: 'Choose the provider to use for subsequent prompts.',
      });
      return;
    }

    if (name === 'resume') {
      this.commandHelpKey = 'command:resume';
      this.commandHelpRequest += 1;
      this.commandHelpLoading.set(false);
      this.commandHelpError.set(null);
      this.commandArgumentHelp.set({
        ...baseHelp(),
        usage: '/resume',
        hint: 'Choose one of your archived sessions for the active CQL Library.',
      });
      return;
    }

    if (name !== 'model') {
      this.commandHelpKey = `command:${name}`;
      this.commandHelpRequest += 1;
      this.commandHelpLoading.set(false);
      this.commandHelpError.set(null);
      this.commandArgumentHelp.set(baseHelp());
      return;
    }

    const provider = this.providerConfig();
    const key = `model:${provider.type}:${provider.baseUrl ?? ''}:${provider.apiKey ?? ''}`;
    if (this.commandHelpKey === key) return;
    this.commandHelpKey = key;
    this.commandHelpError.set(null);
    this.commandHelpLoading.set(true);
    this.commandArgumentHelp.set({
      ...baseHelp(),
      usage: '/model <model>',
      hint: `Choose a model for the ${provider.type} provider.`,
      options: [],
    });
    const request = ++this.commandHelpRequest;
    void this.openCodeService.listProviderModels({
      type: provider.type,
      ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
      ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
    }).then(models => {
      const current = this.promptText().match(/^\/([a-z0-9_-]+)\s*$/i)?.[1].toLowerCase();
      if (request !== this.commandHelpRequest || current !== 'model') return;
      this.commandHelpLoading.set(false);
      this.commandArgumentHelp.update(help => help?.name.toLowerCase() === 'model' ? { ...help, options: models } : help);
    }).catch(error => {
      if (request !== this.commandHelpRequest) return;
      this.commandHelpLoading.set(false);
      this.commandHelpError.set(error instanceof Error ? error.message : 'Models could not be loaded.');
    });
  }

  private providerCommandOptions(): string[] {
    const options: string[] = ['ollama', 'openai'];
    if (this.providerConfig('openai-compatible').baseUrl) options.push('openai-compatible');
    return options;
  }

  private async runSlashCommand(value: string): Promise<void> {
    const session = this.session();
    if (!session) return;
    const match = value.match(/^\/([a-z0-9_-]+)(?:\s+([\s\S]*))?$/i);
    if (!match) {
      this.error.set('Slash command is incomplete.');
      return;
    }
    const [, name, args = ''] = match;
    this.promptText.set('');
    if (this.sessionArchived() && !['help', 'resume', 'new', 'details', 'thinking'].includes(name.toLowerCase())) {
      this.error.set('This session is read-only. Use /resume to continue it with the active CQL Library.');
      return;
    }
    switch (name) {
      case 'help':
        this.showResumeSessions.set(false);
        this.showHelp.set(true);
        this.queueHelpScroll();
        return;
      case 'details': this.detailsShown.update(value => !value); return;
      case 'thinking': this.reasoningShown.update(value => !value); return;
      case 'provider':
        await this.handleProviderCommand(args);
        return;
      case 'model':
        await this.handleModelCommand(args);
        return;
      case 'resume':
        await this.openResumePicker();
        return;
      case 'new':
        this.eventSource?.close();
        await this.startSession();
        return;
      default:
        this.error.set(null);
        this.repairAttempts.set(0);
        this.status.set('busy');
        try {
          await this.syncActiveEditor(session);
          const context = this.contextForPrompt(session);
          const commandArgs = context
            ? `${args}\n\nCurrent editor selection (${context.startLine}:${context.startColumn}-${context.endLine}:${context.endColumn}):\n${context.selectedText}`.trim()
            : args;
          await this.openCodeService.executeCommand(session.id, name, commandArgs, this.reasoningEnabled());
        } catch (error) {
          this.setError(error);
        }
    }
  }

  private async handleProviderCommand(rawProvider: string): Promise<void> {
    const session = this.session();
    const provider = rawProvider.trim().toLowerCase();
    if (!session) return;
    if (!provider) {
      this.error.set('Available providers: ollama, openai, openai-compatible. Use /provider <name>.');
      return;
    }
    const target: AiProviderType = provider === 'ollama' ? 'ollama'
      : provider === 'openai' ? 'openai'
        : provider === 'openai-compatible' || provider === 'compatible' ? 'openai-compatible' : 'ollama';
    if (target === 'ollama' && provider !== 'ollama' || target === 'openai' && provider !== 'openai' || target === 'openai-compatible' && provider !== 'openai-compatible' && provider !== 'compatible') {
      this.error.set(`Unknown provider: ${rawProvider}. Use /provider ollama, /provider openai, or /provider openai-compatible.`);
      return;
    }
    const config = this.providerConfig(target);
    if (target === 'openai-compatible' && !config.baseUrl) {
      this.error.set('Configure an OpenAI-compatible provider URL in Settings before switching to it.');
      return;
    }
    try {
      const model = this.selectedModels.get(target) || config.model;
      await this.openCodeService.switchModel(session.id, config, model);
      this.activeProvider.set(target);
      this.selectedModels.set(target, model);
      this.session.update(current => current ? { ...current, model: `${this.providerId(config)}/${model}` } : current);
      this.error.set(null);
    } catch (error) {
      this.setError(error);
    }
  }

  private async handleModelCommand(rawModel: string): Promise<void> {
    const session = this.session();
    if (!session) return;
    const config = this.providerConfig();
    let model = rawModel.trim();
    try {
      if (!model) {
        const models = await this.openCodeService.listProviderModels({
          type: config.type,
          ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
          ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        });
        this.error.set(models.length ? `Models for ${config.type}: ${models.join(', ')}` : `No models found for ${config.type}.`);
        return;
      }
      await this.openCodeService.switchModel(session.id, config, model);
      this.selectedModels.set(this.activeProvider(), model);
      this.session.update(current => current ? { ...current, model: `${this.providerId(config)}/${model}` } : current);
      this.error.set(null);
    } catch (error) {
      this.setError(error);
    }
  }

  private providerId(provider: { type: AiProviderType; name?: string }): string {
    if (provider.type === 'ollama' || provider.type === 'openai') return provider.type;
    const id = (provider.name || 'custom').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
    return id || 'custom';
  }

  private connectEvents(sessionId: string): void {
    this.reconnectSubscription?.unsubscribe();
    this.reconnectSubscription = null;
    this.eventSource?.close();
    this.eventSource = this.openCodeService.events(
      sessionId,
      envelope => this.handleEnvelope(envelope),
      () => {
        this.streamConnected.set(false);
        this.eventSource?.close();
        this.scheduleReconnect(sessionId);
      },
      () => {
        this.streamConnected.set(true);
        this.reconnectExhausted.set(false);
        this.errorRetryable.set(false);
        this.reconnectAttempts = 0;
      },
      this.lastEventId
    );
  }

  private scheduleReconnect(sessionId: string): void {
    this.reconnectSubscription?.unsubscribe();
    if (this.reconnectAttempts >= MAX_EVENT_RECONNECT_ATTEMPTS) {
      this.reconnectExhausted.set(true);
      this.errorRetryable.set(true);
      this.error.set('Live OpenCode updates disconnected after repeated retries. The session is preserved; retry the connection or end it.');
      return;
    }
    const delay = Math.min(30_000, 1_000 * (2 ** this.reconnectAttempts++));
    this.reconnectSubscription = timer(delay).subscribe(() => void this.reconnectSession(sessionId));
  }

  private async reconnectSession(sessionId: string): Promise<void> {
    if (this.session()?.id !== sessionId) return;
    try {
      this.hydrate(await this.openCodeService.getState(sessionId));
      this.connectEvents(sessionId);
    } catch (error) {
      if (error instanceof OpenCodeApiError && ['SESSION_NOT_FOUND', 'SESSION_EXPIRED'].includes(error.code)) {
        this.resetConversation();
        this.session.set(null);
        this.status.set('idle');
        this.error.set('The OpenCode session ended. Start a new session to continue.');
        return;
      }
      this.errorRetryable.set(true);
      this.scheduleReconnect(sessionId);
    }
  }

  private handleEnvelope(envelope: OpenCodeEventEnvelope): void {
    const followOutput = this.isNearTimelineBottom();
    this.lastEventId = Math.max(this.lastEventId, envelope.id);
    this.streamConnected.set(true);
    this.handleEvent(envelope.event);
    if (followOutput) this.queueTimelineScroll(true);
  }

  private handleEvent(event: OpenCodeEvent): void {
    if (event.type === 'cql.workspace.changed') {
      this.validation.set(null);
      if (!this.environmentStale()) {
        this.handleWorkspaceChange(event.properties);
      }
      return;
    }
    if (event.type === 'attachments.compacted') {
      this.attachments.set([]);
      return;
    }
    if (event.type === 'message.updated') {
      const info = event.properties['info'] as Record<string, unknown> | undefined;
      this.ingestMessageInfo(info);
      return;
    }
    if (event.type === 'message.part.updated') {
      this.ingestPart(event.properties['part'] as Record<string, unknown> | undefined);
      return;
    }
    if (event.type === 'permission.updated' || event.type === 'permission.asked') {
      const raw = event.properties as Record<string, unknown>;
      const id = String(raw['id'] ?? raw['requestID'] ?? '');
      if (id) this.permissions.update(items => [...items.filter(item => item.id !== id), { ...raw, id } as unknown as OpenCodePermissionRequest]);
      return;
    }
    if (event.type === 'permission.replied') {
      const permissionId = event.properties['permissionID'] ?? event.properties['requestID'];
      if (typeof permissionId === 'string') this.permissions.update(items => items.filter(item => item.id !== permissionId));
      return;
    }
    if (event.type === 'question.asked') {
      const raw = event.properties as unknown as OpenCodeQuestionRequest;
      if (raw.id) this.questions.update(items => [...items.filter(item => item.id !== raw.id), raw]);
      return;
    }
    if (event.type === 'question.replied' || event.type === 'question.rejected') {
      const requestId = event.properties['requestID'];
      if (typeof requestId === 'string') this.removeQuestion(requestId);
      return;
    }
    if (event.type === 'session.status') {
      const sessionStatus = event.properties['status'] as { type?: string } | undefined;
      this.status.set(sessionStatus?.type === 'busy' ? 'busy' : 'idle');
      return;
    }
    if (event.type === 'session.idle') {
      this.status.set('idle');
      this.repairInFlight = false;
      void this.refreshDiff();
      return;
    }
    if (event.type === 'cql.validation.updated') {
      void this.processValidation(event.properties as unknown as OpenCodeValidation);
      return;
    }
    if (event.type === 'cql.validation.error') {
      this.upsertActivity({
        id: `validation-error-${Date.now()}`,
        kind: 'validation', title: 'CQL validation unavailable', status: 'error',
        detail: String(event.properties['message'] ?? 'Validation failed'),
      });
      return;
    }
    if (event.type === 'runner.error') {
      this.status.set('error');
      const message = event.properties['message'];
      this.error.set(typeof message === 'string' ? message : 'The OpenCode session failed.');
      this.errorRetryable.set(true);
      return;
    }
    if (event.type === 'session.error') {
      this.status.set('error');
      const providerError = event.properties['error'] as { name?: string; data?: { message?: string } } | undefined;
      // A runner timeout aborts the underlying OpenCode request. Preserve the
      // actionable timeout message instead of replacing it with only "Aborted".
      if (providerError?.name !== 'MessageAbortedError' || !this.error()) {
        const message = event.properties['message'] ?? providerError?.data?.message;
        this.error.set(typeof message === 'string' ? message : 'The OpenCode session failed.');
      }
      this.errorRetryable.set(true);
    }
  }

  private handleWorkspaceChange(properties: Record<string, unknown>): void {
    if (!this.liveEditsEnabled()) return;
    const libraryId = typeof properties['libraryId'] === 'string' ? properties['libraryId'] : '';
    const file = typeof properties['file'] === 'string' ? properties['file'] : '';
    const content = typeof properties['content'] === 'string' ? properties['content'] : null;
    const baseRevision = Number(properties['baseRevision']);
    const document = this.editorBridge.document();
    if (!content || !document || document.libraryId !== libraryId) return;
    if (!Number.isFinite(baseRevision) || baseRevision !== document.userRevision) {
      this.liveEditsEnabled.set(false);
      this.liveConflict.set('Live edits paused because the CQL document changed after OpenCode started. Review the workspace diff before applying it.');
      return;
    }
    if (!this.liveBaselines.has(file)) this.liveBaselines.set(file, document.content);
    this.applyLibraryChange.emit({ libraryId, cqlContent: content, save: false, mode: 'live', baseRevision });
  }

  private contextForPrompt(session: OpenCodeSession): OpenCodeEditorContext | null {
    const context = this.inlineContext() ?? this.selectedContext();
    if (!context || context.libraryId !== session.activeLibraryId) return null;
    return { ...context, file: session.activeFile };
  }

  private async syncActiveEditor(session: OpenCodeSession): Promise<void> {
    const active = this.activeLibrary();
    if (!active || active.id !== session.activeLibraryId) {
      throw new OpenCodeApiError({
        code: 'ACTIVE_LIBRARY_CHANGED',
        message: 'This OpenCode session belongs to a different library. Start a new session for the active library.',
        retryable: false,
      }, 409);
    }
    const document = this.editorBridge.document();
    const content = document?.libraryId === active.id ? document.content : active.cqlContent;
    const revision = document?.libraryId === active.id ? document.userRevision : 0;
    if (document?.libraryId !== active.id) this.editorBridge.recordDocument(active.id, content, revision);
    this.savedDiffFiles.update(files => { const next = new Set(files); next.delete(session.activeFile); return next; });
    await this.openCodeService.syncActiveFile(session.id, content, revision);
  }

  private ingestMessageInfo(info?: Record<string, unknown>): void {
    const id = typeof info?.['id'] === 'string' ? info['id'] : null;
    const role = info?.['role'];
    if (!id || (role !== 'user' && role !== 'assistant')) return;
    this.messageRoles.set(id, role);
    if (!this.messageOrders.has(id)) this.messageOrders.set(id, this.nextTimelineOrder());
    const messageError = info?.['error'] as { name?: string; data?: { message?: string } } | undefined;
    if (messageError?.data?.message && (messageError.name !== 'MessageAbortedError' || !this.error())) {
      this.error.set(messageError.data.message);
    }
    this.rebuildMessages();
  }

  private ingestPart(part?: Record<string, any>): void {
    if (!part) return;
    const messageId = typeof part['messageID'] === 'string' ? part['messageID'] : undefined;
    const partId = typeof part['id'] === 'string' ? part['id'] : `${part['type']}-${Date.now()}`;
    if (part['type'] === 'text' && messageId) {
      const text = typeof part['text'] === 'string' ? part['text'] : '';
      // Editor context is a model-only prompt part. The visible selection chip
      // communicates it without duplicating internal range markup in the chat.
      if (text.includes('<cql-studio-editor-context') || text.includes('<cql-studio-problems-context') || text.includes('<cql-studio-resume-context')) return;
      const parts = this.messageParts.get(messageId) ?? new Map<string, string>();
      parts.set(partId, text);
      this.messageParts.set(messageId, parts);
      this.rebuildMessages();
      return;
    }
    if (part['type'] === 'reasoning') {
      this.upsertActivity({
        id: partId, messageId, kind: 'reasoning', title: part['time']?.end ? 'Reasoning completed' : 'Reasoning…',
        status: part['time']?.end ? 'completed' : 'running', detail: String(part['text'] ?? ''),
        startedAt: part['time']?.start, endedAt: part['time']?.end,
      });
    } else if (part['type'] === 'tool') {
      const state = part['state'] ?? {};
      this.upsertActivity({
        id: partId, messageId, kind: 'tool', title: state.title || part['tool'] || 'Tool',
        status: state.status || 'pending',
        detail: this.safeJson(state.input), output: state.output || state.error,
        startedAt: state.time?.start, endedAt: state.time?.end,
      });
    } else if (part['type'] === 'step-finish') {
      this.upsertActivity({
        id: partId, messageId, kind: 'step', title: 'Step completed', status: 'completed',
        detail: `${part['tokens']?.input ?? 0} input · ${part['tokens']?.output ?? 0} output`,
        reasoningTokens: part['tokens']?.reasoning,
      });
    } else if (part['type'] === 'retry') {
      this.upsertActivity({ id: partId, messageId, kind: 'retry', title: 'OpenCode retrying', status: 'running', detail: this.safeJson(part['error']) });
    } else if (part['type'] === 'compaction') {
      this.upsertActivity({ id: partId, messageId, kind: 'compaction', title: 'Session compacted', status: 'completed' });
    }
  }

  private async processValidation(validation: OpenCodeValidation): Promise<void> {
    this.validation.set(validation);
    await this.refreshDiff();
    this.upsertActivity({
      id: 'current-validation', kind: 'validation',
      title: validation.valid ? 'CQL validation passed' : 'CQL validation failed',
      status: validation.valid ? 'completed' : 'error',
      detail: `${validation.diagnostics.filter(item => item.severity === 'error').length} errors · ${validation.diagnostics.filter(item => item.severity === 'warning').length} warnings`,
    }, true);
    if (
      validation.valid
      || this.diffs().length === 0
      || this.repairInFlight
      || this.repairAttempts() >= 2
      || this.environmentStale()
    ) return;
    const session = this.session();
    if (!session) return;
    const attempt = this.repairAttempts() + 1;
    this.repairAttempts.set(attempt);
    this.repairInFlight = true;
    this.upsertActivity({
      id: `repair-${attempt}`, kind: 'repair', title: `Automatic CQL repair ${attempt}/2`, status: 'running',
      detail: 'OpenCode is repairing compiler errors before changes can be saved.',
    });
    const diagnostics = validation.diagnostics.filter(item => item.severity === 'error')
      .map(item => `${item.file ?? ''}:${item.line ?? '?'}:${item.column ?? '?'} ${item.message}`).join('\n');
    this.status.set('busy');
    try {
      await this.openCodeService.prompt(
        session.id,
        `The proposed CQL failed validation. Repair only these errors while preserving the user's intent. This is automatic repair attempt ${attempt} of 2.\n\n${diagnostics}`,
        'build',
        [session.activeFile],
        this.reasoningEnabled()
      );
    } catch (error) {
      this.repairInFlight = false;
      this.setError(error);
    }
  }

  private hydrate(state: OpenCodeSessionState): void {
    this.session.set(state.session);
    this.status.set(state.session.status);
    this.reasoningEnabled.set(state.session.reasoningEnabled);
    this.diffs.set(state.diffs);
    this.attachments.set(state.attachments ?? []);
    this.validation.set(state.validation);
    this.permissions.set(state.permissions ?? []);
    this.questions.set(state.questions ?? []);
    this.lastEventId = state.lastEventId ?? 0;
    this.commands.set([...WEB_COMMANDS, ...state.commands.filter(command => !WEB_COMMANDS.some(local => local.name === command.name))]);
    for (const raw of state.messages as Array<Record<string, any>>) {
      this.ingestMessageInfo(raw['info']);
      for (const part of raw['parts'] ?? []) this.ingestPart(part);
    }
    this.queueTimelineScroll(true);
  }

  private rebuildMessages(): void {
    const messages: OpenCodeUiMessage[] = [];
    for (const [id, role] of this.messageRoles) {
      const text = [...(this.messageParts.get(id)?.values() ?? [])].join('\n');
      if (text.trim()) messages.push({ id, role, text, order: this.messageOrders.get(id) ?? this.nextTimelineOrder() });
    }
    this.messages.set(messages);
  }

  private referencesFrom(message: string): string[] {
    return [...message.matchAll(/@((?:libraries|dependencies)\/[A-Za-z0-9._-]+\.cql)\b/g)].map(match => match[1]);
  }

  private resetConversation(): void {
    this.eventSource?.close();
    this.eventSource = null;
    this.reconnectSubscription?.unsubscribe();
    this.reconnectSubscription = null;
    this.reconnectAttempts = 0;
    this.lastEventId = 0;
    this.messages.set([]);
    this.activities.set([]);
    this.diffs.set([]);
    this.validation.set(null);
    this.permissions.set([]);
    this.questions.set([]);
    this.questionAnswers.set({});
    this.promptText.set('');
    this.fileSuggestions.set([]);
    this.attachments.set([]);
    this.messageRoles.clear();
    this.messageOrders.clear();
    this.messageParts.clear();
    this.activityParts.clear();
    this.error.set(null);
    this.errorRetryable.set(false);
    this.streamConnected.set(false);
    this.reconnectExhausted.set(false);
    this.repairAttempts.set(0);
    this.repairInFlight = false;
    this.inlineContext.set(null);
    this.autoSendInlineRequest.set(false);
    this.liveConflict.set(null);
    this.liveBaselines.clear();
    this.savedDiffFiles.set(new Set());
    this.savingDiffFiles.set(new Set());
    this.timelineSequence = 0;
  }

  private nextTimelineOrder(): number {
    this.timelineSequence += 1;
    return this.timelineSequence;
  }

  private orderTimeline(items: OpenCodeTimelineItem[]): OpenCodeTimelineItem[] {
    const ordered: OpenCodeTimelineItem[] = [];
    let turn: OpenCodeTimelineItem[] = [];
    const flushTurn = (): void => {
      if (turn.length === 0) return;
      let finalMessageIndex = -1;
      for (let index = 0; index < turn.length; index += 1) {
        const item = turn[index];
        if (item.kind === 'message' && item.message.role === 'assistant') finalMessageIndex = index;
      }
      if (finalMessageIndex < 0) {
        ordered.push(...turn);
      } else {
        const finalMessage = turn[finalMessageIndex];
        ordered.push(...turn.filter((_item, index) => index !== finalMessageIndex), finalMessage);
      }
      turn = [];
    };
    for (const item of items) {
      if (item.kind === 'message' && item.message.role === 'user') flushTurn();
      turn.push(item);
    }
    flushTurn();
    return ordered;
  }

  private upsertActivity(activity: Omit<OpenCodeActivity, 'order'>, moveToEnd = false): void {
    const existing = this.activityParts.get(activity.id);
    this.activityParts.set(activity.id, {
      ...activity,
      order: moveToEnd || !existing ? this.nextTimelineOrder() : existing.order,
    });
    this.activities.set([...this.activityParts.values()]);
  }

  private isNearTimelineBottom(): boolean {
    const element = this.messageScroller?.nativeElement;
    return !element || element.scrollHeight - element.scrollTop - element.clientHeight < 120;
  }

  private queueTimelineScroll(force = false): void {
    requestAnimationFrame(() => {
      const element = this.messageScroller?.nativeElement;
      if (element && (force || this.isNearTimelineBottom())) element.scrollTop = element.scrollHeight;
    });
  }

  private queueHelpScroll(): void {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      this.helpCard?.nativeElement.scrollIntoView({ block: 'start' });
    }));
  }

  private removeQuestion(requestId: string): void {
    this.questions.update(items => items.filter(item => item.id !== requestId));
    this.questionAnswers.update(current => {
      const next = { ...current };
      delete next[requestId];
      return next;
    });
  }

  private snapshot(library: LibraryResource): OpenCodeLibrarySnapshot {
    return {
      id: library.id,
      name: library.name || library.id,
      version: library.version,
      canonicalUrl: library.url,
      cqlContent: library.cqlContent,
      originalContent: library.originalContent,
      fhirVersionId: library.library?.meta?.versionId,
      workspaceOrigin: library.workspaceOrigin,
    };
  }

  private contentForLibrary(library: LibraryResource): string {
    const document = this.editorBridge.document();
    return document?.libraryId === library.id ? document.content : library.cqlContent;
  }

  private problemsContext(session: OpenCodeSession): OpenCodeIdeDiagnostics | undefined {
    const active = this.activeLibrary();
    const document = this.editorBridge.document();
    if (!active || !document || active.id !== session.activeLibraryId || document.libraryId !== active.id) return undefined;
    return buildOpenCodeProblemsContext({
      libraryId: active.id,
      file: session.activeFile,
      documentRevision: document.userRevision,
      problems: this.ideStateService.editorState().syntaxErrors,
    });
  }

  private async collectDependencies(active: LibraryResource, activeContent = this.contentForLibrary(active)): Promise<OpenCodeLibrarySnapshot[]> {
    const openLibraries = this.ideStateService.libraryResources();
    const byName = new Map(openLibraries.map(library => [library.name.toLowerCase(), library]));
    const selected = new Map<string, OpenCodeLibrarySnapshot>();
    const pending = [activeContent];
    while (pending.length > 0) {
      for (const includeName of this.includeNames(pending.shift() ?? '')) {
        const dependency = byName.get(includeName.toLowerCase());
        if (!dependency || dependency.id === active.id || selected.has(dependency.id)) continue;
        selected.set(dependency.id, this.snapshot(dependency));
        pending.push(dependency.cqlContent);
      }
    }
    const hasFhirHelpers = [...selected.values()].some(dependency => dependency.name.toLowerCase() === 'fhirhelpers');
    if (active.name.toLowerCase() !== 'fhirhelpers' && !hasFhirHelpers) {
      const response = await fetch('/cql/FHIRHelpers-4.0.1.cql');
      if (!response.ok) throw new Error(`Unable to load the bundled FHIRHelpers 4.0.1 dependency (${response.status})`);
      selected.set('FHIRHelpers', {
        id: 'FHIRHelpers',
        name: 'FHIRHelpers',
        version: '4.0.1',
        cqlContent: await response.text(),
      });
    }
    return [...selected.values()];
  }

  private includeNames(content: string): string[] {
    return [...content.matchAll(/^\s*include\s+([A-Za-z][A-Za-z0-9_]*)\b/gim)].map(match => match[1]);
  }

  private safeJson(value: unknown): string | undefined {
    if (value == null || (typeof value === 'object' && Object.keys(value as object).length === 0)) return undefined;
    try { return JSON.stringify(value, null, 2).slice(0, 4_000); } catch { return String(value); }
  }

  private setError(error: unknown): void {
    this.status.set('error');
    this.error.set(error instanceof Error ? error.message : String(error));
    this.errorRetryable.set(error instanceof OpenCodeApiError && error.retryable);
  }
}
