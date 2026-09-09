// Author: Preston Lee

import {Component, ChangeDetectionStrategy, input, output, viewChild, ElementRef, AfterViewInit, OnDestroy, signal, computed, effect, inject, DestroyRef, untracked} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { EditorView, Decoration, DecorationSet, keymap, WidgetType } from '@codemirror/view';
import { Compartment, EditorState, Prec, StateEffect, StateField } from '@codemirror/state';
import { linter, lintGutter, Diagnostic } from '@codemirror/lint';
import { firstValueFrom, Subscription, timer } from 'rxjs';
import { CqlGrammarManager } from '../../../../services/cql-grammar-manager.service';
import { createCqlEditorBaseExtensions } from '../../../../services/cql-codemirror-extensions.lib';
import { createCqlEditorThemeExtensions } from '../../../../services/cql-editor-theme.lib';
import { scanInvalidCqlCharacters } from '../../../../services/cql-character-lint.lib';
import { IdeEditor, EditorState as IdeEditorState } from '../base-editor.interface';
import {
  IdeFindReferencesResult,
  IdeStateService,
  IdeValuesetPeekResult
} from '../../../../services/ide-state.service';
import { CqlFormatterService } from '../../../../services/cql-formatter.service';
import { CqlValidationService, FullValidationResult, ValidationResult } from '../../../../services/cql-validation.service';
import { LibraryTranslationContextBuilder } from '../../../../services/library-translation-context.lib';
import { CqlDefinitionIndexService, elmColumnToCodeMirror } from '../../../../services/cql-definition-index.service';
import {
  CqlDefinitionIndex,
  CqlExpressionDefinition,
  isReferenceResolvableSync,
  positionContains,
  findDefinition,
  expressionDefinitions
} from '../../../../services/elm-locator.lib';
import { CqlIdeLibraryOpenerService } from '../../../../services/cql-ide-library-opener.service';
import { SettingsService } from '../../../../services/settings.service';
import { OpenCodeEditorBridgeService } from '../../../../services/opencode-editor-bridge.service';
import { OpenCodeService } from '../../../../services/opencode.service';
import { OpenCodeEditorContext } from '../../../../models/opencode.model';
import {
  createEditorActionsExtension,
  CqlEditorAction,
  reconfigureDefinitionIndex
} from '../../../../services/cql-codemirror-editor-actions.lib';
import {
  buildTerminologySymbolIndex,
  buildTerminologySymbolIndexFromElm,
  findTerminologySymbolAt,
  CqlTerminologySymbolIndex,
  provisionalFhirIdFromUrl
} from '../../../../services/cql-terminology-symbols.lib';
import { CqlTerminologyExistenceService } from '../../../../services/cql-terminology-existence.service';
import { TerminologyResourceOpenerService } from '../../../../services/terminology-resource-opener.service';
import { TerminologyService } from '../../../../services/terminology.service';
import { LibraryService } from '../../../../services/library.service';
import { describeFhirHttpFailure } from '../../../../services/fhir-http-error.lib';
import { createIncludeLibraryCompletionSource } from '../../../../services/cql-include-completion.lib';
import {
  extractElmHoverTypeInfos,
  formatHoverTypeInfo,
  ElmHoverTypeInfo
} from '../../../../services/elm-hover-type.lib';
import {
  collectLocalRenameSpans,
  findDefineNameTokenSpan,
  formatRenameReplacement
} from '../../../../services/cql-symbol-rename.lib';
import {
  formatCharacterDiagnosticsForProblems,
  problemsIndicateValidSyntax
} from '../../../../services/cql-problems-message.lib';
import { RenameSymbolModalComponent } from '../../rename-symbol-modal/rename-symbol-modal.component';
import {
  buildCqlAiDiagnosticFixRequest,
  CqlAiDiagnosticFixRequest,
} from '../../../../services/cql-ai-diagnostic-fix.lib';

const setReferenceHighlightEffect = StateEffect.define<DecorationSet>();
const referenceHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value;
    for (const effect of tr.effects) {
      if (effect.is(setReferenceHighlightEffect)) {
        next = effect.value;
      }
    }
    if (tr.docChanged) {
      next = Decoration.none;
    }
    return next;
  },
  provide: field => EditorView.decorations.from(field)
});

const setAiEditHighlightEffect = StateEffect.define<{ from: number; to: number } | null>();
const aiEditHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = transaction.docChanged ? Decoration.none : value.map(transaction.changes);
    for (const stateEffect of transaction.effects) {
      if (!stateEffect.is(setAiEditHighlightEffect)) continue;
      const range = stateEffect.value;
      next = range && range.to > range.from
        ? Decoration.set([Decoration.mark({ class: 'cm-ai-live-edit' }).range(range.from, range.to)])
        : Decoration.none;
    }
    return next;
  },
  provide: field => EditorView.decorations.from(field),
});

class CqlPredictionWidget extends WidgetType {
  constructor(private readonly completion: string) { super(); }
  override toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-ai-prediction';
    span.textContent = this.completion;
    span.title = 'AI prediction — Tab to accept, Escape to dismiss';
    return span;
  }
  override eq(other: CqlPredictionWidget): boolean { return other.completion === this.completion; }
  override ignoreEvent(): boolean { return true; }
}

const setPredictionEffect = StateEffect.define<{ from: number; text: string } | null>();
const predictionField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = transaction.docChanged ? Decoration.none : value.map(transaction.changes);
    for (const stateEffect of transaction.effects) {
      if (!stateEffect.is(setPredictionEffect)) continue;
      const prediction = stateEffect.value;
      next = prediction
        ? Decoration.set([Decoration.widget({ widget: new CqlPredictionWidget(prediction.text), side: 1 }).range(prediction.from)])
        : Decoration.none;
    }
    return next;
  },
  provide: field => EditorView.decorations.from(field),
});

@Component({
  selector: 'app-cql-editor',
  imports: [FormsModule, RenameSymbolModalComponent],
  templateUrl: './cql-editor.component.html',

  styleUrls: ['./cql-editor.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CqlEditorComponent implements AfterViewInit, OnDestroy, IdeEditor {
  editorContainer = viewChild<ElementRef<HTMLDivElement>>('editorContainer');
  
  libraryId = input<string>('');
  editorState = input<any>();
  placeholder = input<string>('Enter CQL code here...');
  height = input<string>('500px');
  readonly = input<boolean>(false);
  contentLoading = input<boolean>(false);
  contentLoadError = input<string | null>(null);
  isNewLibrary = input<boolean>(false);
  
  contentChange = output<{ cursorPosition: { line: number; column: number }, wordCount: number, content: string, source: 'user' | 'ai', userRevision: number }>();
  selectionChange = output<OpenCodeEditorContext | null>();
  inlineAiEditRequested = output<OpenCodeEditorContext>();
  diagnosticAiFixRequested = output<CqlAiDiagnosticFixRequest>();
  cursorChange = output<{ line: number; column: number }>();
  editorStateChange = output<IdeEditorState>();
  syntaxErrors = output<string[]>();
  /** Prefer template bindings so zoneless CD schedules like Problems. */
  findReferencesResultChange = output<IdeFindReferencesResult | null>();
  valuesetPeekResultChange = output<IdeValuesetPeekResult | null>();
  executeLibrary = output<void>();
  reloadLibrary = output<void>();
  formatCql = output<void>();
  validateCql = output<void>();
  saveLibrary = output<void>();

  private editor?: EditorView;
  private grammarManager: CqlGrammarManager;
  private themeCompartment = new Compartment();
  private _value: string = '';
  private isInitializing: boolean = false;
  private initializationRetries: number = 0;
  private maxRetries: number = 10;
  private resizeObserver?: ResizeObserver;
  private viewDestroyed = false;
  private suppressOutputEmits = false;
  private userRevision = 0;
  private applyingAiChange = false;
  private predictionSubscription?: Subscription;
  private predictionAbort?: AbortController;
  private pendingPrediction: { from: number; text: string; revision: number } | null = null;

  // Toolbar properties
  isExecuting: boolean = false;
  protected readonly executionScope = signal<'all' | 'custom'>('all');
  protected readonly selectedExpressionNames = signal<ReadonlySet<string>>(new Set());
  
  // Signal for canExecute state
  private _canExecuteSignal = signal(false);
  
  // Computed signal for canExecute
  canExecute = computed(() => this._canExecuteSignal());
  
  // Signal for form validity state
  private _isFormValidSignal = signal(false);
  
  // Computed signal for form validity
  isFormValid = computed(() => this._isFormValidSignal());

  private ideStateService = inject(IdeStateService);
  private settingsService = inject(SettingsService);
  private readonly openCodeEditorBridge = inject(OpenCodeEditorBridgeService);
  private openCodeService = inject(OpenCodeService);
  private cqlFormatterService = inject(CqlFormatterService);
  private cqlValidationService = inject(CqlValidationService);
  private libraryTranslationContextBuilder = inject(LibraryTranslationContextBuilder);
  private definitionIndexService = inject(CqlDefinitionIndexService);
  private libraryOpenerService = inject(CqlIdeLibraryOpenerService);
  private terminologyExistence = inject(CqlTerminologyExistenceService);
  private terminologyOpener = inject(TerminologyResourceOpenerService);
  private terminologyService = inject(TerminologyService);
  private libraryService = inject(LibraryService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly expressions = signal<CqlExpressionDefinition[]>([]);
  protected readonly expressionFilter = signal('');
  protected readonly sortedExpressions = computed(() =>
    [...this.expressions()].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    )
  );
  protected readonly visibleExpressions = computed(() => {
    const filter = this.expressionFilter().trim().toLowerCase();
    const sorted = this.sortedExpressions();
    if (!filter) {
      return sorted;
    }
    return sorted.filter(expression => expression.name.toLowerCase().includes(filter));
  });
  protected readonly executeButtonTitle = computed(() => {
    if (this.executionScope() === 'custom' && this.selectedExpressionNames().size === 0) {
      return 'Select at least one expression';
    }
    return this.canExecute() ? 'Execute Library' : 'Save library before executing';
  });

  private definitionIndex: CqlDefinitionIndex | null = null;
  /** True after edits until the next successful ELM index rebuild. */
  private definitionIndexDirty = false;
  private terminologyIndex: CqlTerminologySymbolIndex = buildTerminologySymbolIndex('');
  private hoverTypeInfos = new Map<string, ElmHoverTypeInfo[]>();
  protected readonly renameModalOpen = signal(false);
  protected readonly renameOldName = signal('');
  private renameKind: 'expression' | 'function' | undefined;

  // Debouncing for validation
  private validationDebounceFrame?: number;
  private readonly VALIDATION_DEBOUNCE_MS = 250;
  private validationGeneration = 0;
  private currentValidationErrors: string[] = [];
  private pendingLintResolvers: Array<(diagnostics: Diagnostic[]) => void> = [];
  
  // Flag to prevent contentChange events during programmatic updates
  private isUpdatingFromReload: boolean = false;

  constructor() {
    this.grammarManager = new CqlGrammarManager();
    this.destroyRef.onDestroy(() => {
      this.viewDestroyed = true;
    });
    
    // Watch for libraryId changes
    effect(() => {
      const libraryId = this.libraryId();
      this.expressions.set([]);
      if (libraryId && this.editor) {
        this.reinitializeEditor();
        this.updateCanExecute();
      }
    });

    effect(() => {
      const theme = this.settingsService.theme_effective();
      if (this.editor) {
        this.editor.dispatch({
          effects: this.themeCompartment.reconfigure(
            createCqlEditorThemeExtensions(theme, this.height())
          )
        });
      }
    });

    effect(() => {
      const request = this.ideStateService.renameSymbolRequest();
      if (!request || request.libraryId !== this.libraryId()) {
        return;
      }
      const consumed = this.ideStateService.consumeRenameSymbolRequest();
      if (!consumed) {
        return;
      }
      this.openRenameModal(consumed.oldName, consumed.kind ?? 'expression');
    });

    // When contentLoading or contentLoadError is set, destroy editor; when both clear, init editor if container is present
    effect(() => {
      const loading = this.contentLoading();
      const loadError = this.contentLoadError();
      if ((loading || loadError) && this.editor) {
        this.teardownEditor();
      }
      if (!loading && !loadError && this.editorContainer()?.nativeElement && !this.editor && !this.isInitializing) {
        this.initializeEditor();
        this.setupResizeObserver();
        this.tryConsumePendingNavigation();
      }
    });
    
    // Watch for reload trigger signal
    effect(() => {
      const pending = this.ideStateService.pendingEditorNavigation();
      const libraryId = this.libraryId();
      if (pending?.libraryId === libraryId && this.editor && !this.contentLoading()) {
        this.tryConsumePendingNavigation();
      }
    });

    effect(() => {
      const reloadTrigger = this.ideStateService.reloadTrigger();
      const libraryId = this.libraryId();
      
      if (!reloadTrigger || !libraryId || !this.editor) {
        return;
      }
      
      // Only act if this reload is for the current library
      if (reloadTrigger.libraryId !== libraryId) {
        return;
      }
      
      // Get the library resource
      const library = this.ideStateService.libraryResources().find(lib => lib.id === libraryId);
      if (!library) {
        return;
      }
      
      // Set flag to prevent contentChange event from triggering parent updates
      this.isUpdatingFromReload = true;
      try {
        this.setValue(library.cqlContent);
        this.updateCanExecute();
      } finally {
        queueMicrotask(() => {
          this.isUpdatingFromReload = false;
        });
      }
    });

    // Re-run canExecute when library resource is updated (e.g. after save)
    effect(() => {
      const libraryId = this.libraryId();
      const resources = this.ideStateService.libraryResources();
      const library = resources.find(lib => lib.id === libraryId);
      if (library) {
        void library.originalContent;
        void library.isDirty;
        this.updateCanExecute();
      }
    });

    effect(() => {
      const available = new Set(this.expressions().map(expression => expression.name));
      const selected = this.selectedExpressionNames();
      let changed = false;
      const next = new Set<string>();
      for (const name of selected) {
        if (available.has(name)) {
          next.add(name);
        } else {
          changed = true;
        }
      }
      if (changed) {
        untracked(() => {
          this.selectedExpressionNames.set(next);
          this.updateCanExecute();
        });
      }
    });
  }

  // Get content for this specific library
  private getLibraryContent(): string {
    if (!this.libraryId()) return '';
    const library = this.ideStateService.libraryResources().find(lib => lib.id === this.libraryId());
    return library?.cqlContent || '';
  }

  ngAfterViewInit(): void {
    if (this.contentLoading() || this.contentLoadError()) {
      return;
    }
    if (!this.isInitializing && !this.editor && this.editorContainer()?.nativeElement) {
      this.initializeEditor();
      this.setupResizeObserver();
    }
  }

  ngOnDestroy(): void {
    this.viewDestroyed = true;
    this.cancelValidationDebounce();
    this.teardownEditor();
  }

  private canEmitOutputs(): boolean {
    return !this.viewDestroyed && !this.suppressOutputEmits;
  }

  private teardownEditor(): void {
    this.suppressOutputEmits = true;
    try {
      this.cancelPrediction(false);
      this.resizeObserver?.disconnect();
      this.resizeObserver = undefined;
      if (this.editor) {
        this.editor.destroy();
        this.editor = undefined;
      }
    } finally {
      this.suppressOutputEmits = false;
    }
  }

  private initializeEditor(): void {
    this.userRevision = this.openCodeEditorBridge.documents().get(this.libraryId())?.userRevision ?? this.userRevision;
    if (this.isInitializing) {
      return;
    }
    
    if (!this.editorContainer()?.nativeElement) {
      return;
    }
    
    if (this.editor) {
      return;
    }
    
    this.isInitializing = true;
    
    const container = this.editorContainer()!.nativeElement;
    if (container.offsetWidth === 0 || container.offsetHeight === 0) {
      this.initializationRetries++;
      
      if (this.initializationRetries >= this.maxRetries) {
        console.error('Max initialization retries reached, forcing initialization with fallback dimensions');
        // Force initialization with fallback dimensions
        container.style.minHeight = '200px';
        container.style.minWidth = '300px';
        // Continue with initialization
      } else {
        this.isInitializing = false;
        // Use ResizeObserver to detect when container becomes available
        this.setupResizeObserver();
        return;
      }
    }
    
    try {
      // Get content for this specific library
      const initialContent = this.getLibraryContent();
      this._value = initialContent; // Sync _value with the actual content
      this.rebuildTerminologyIndex(initialContent);
      const includeCompletion = createIncludeLibraryCompletionSource({
        searchLibraries: term => this.libraryService.searchPaginated(term, 1, 50, 'name', 'asc'),
        listLibraries: () => this.libraryService.getAll(1, 50, 'name', 'asc')
      });
      const startState = EditorState.create({
        doc: initialContent,
        extensions: [
          ...createCqlEditorBaseExtensions(),
          ...this.grammarManager.createExtensions([includeCompletion]),
          ...createEditorActionsExtension(this.createEditorActionsHandlers()),
          referenceHighlightField,
          aiEditHighlightField,
          predictionField,
          lintGutter(),
          linter(this.createLintSource()),
          Prec.highest(keymap.of([
            {
              key: 'Mod-i',
              run: () => {
                const context = this.editorContext('inline', true);
                if (context) this.inlineAiEditRequested.emit(context);
                return true;
              }
            },
            {
              key: 'Escape',
              run: () => this.dismissPrediction()
            },
            {
              key: 'Tab',
              run: (view) => {
                if (this.acceptPrediction()) return true;
                // Insert tab character at cursor position
                const selection = view.state.selection.main;
                view.dispatch({
                  changes: {
                    from: selection.from,
                    to: selection.to,
                    insert: '\t'
                  },
                  selection: { anchor: selection.from + 1 }
                });
                return true;
              }
            },
            {
              key: 'Ctrl-Shift-f',
              run: () => {
                this.formatCode();
                return true;
              }
            },
            {
              key: 'Ctrl-k',
              run: () => {
                this.clearCode();
                return true;
              }
            },
            {
              key: 'Shift-F12',
              run: (view) => {
                const pos = view.state.selection.main.head;
                const lineInfo = view.state.doc.lineAt(pos);
                const column = pos - lineInfo.from;
                this.findReferencesAt(lineInfo.number, column);
                return true;
              }
            }
          ])),
          this.themeCompartment.of(
            createCqlEditorThemeExtensions(this.settingsService.theme_effective(), this.height())
          ),
          EditorView.updateListener.of((update) => {
            if (!this.canEmitOutputs()) {
              return;
            }
            if (update.docChanged) {
              const newValue = update.state.doc.toString();
              const source: 'user' | 'ai' = this.applyingAiChange ? 'ai' : 'user';
              if (source === 'user' && !this.isUpdatingFromReload) this.userRevision += 1;
              this.cancelPrediction(false);
              this._value = newValue;
              this.invalidateElmDerivedNavigation(newValue);
              
              // Update form validity signal
              this._isFormValidSignal.set(newValue.trim().length > 0);
              
              // Only emit contentChange if this is not a programmatic update from reload
              if (!this.isUpdatingFromReload) {
                const cursor = this.getCursorPosition();
                const wordCount = this.getWordCount();
                this.contentChange.emit({ 
                  cursorPosition: cursor || { line: 1, column: 1 }, 
                  wordCount: wordCount || 0,
                  content: newValue,
                  source,
                  userRevision: this.userRevision
                });
                
                // Update canExecute state after content change
                this.updateCanExecute();
                if (source === 'user') this.schedulePrediction();
              }
              
              // Library resource update will be handled by parent component
              // to avoid change detection issues
            }
            
            if (update.selectionSet) {
              const selection = update.state.selection.main;
              const line = update.state.doc.lineAt(selection.from).number;
              const column = selection.from - update.state.doc.lineAt(selection.from).from;
              this.cursorChange.emit({ line, column });
              this.selectionChange.emit(this.editorContext('selection', false));
              if (!update.docChanged) queueMicrotask(() => this.cancelPrediction());
            }
            
            // Update word count
            const text = update.state.doc.toString();
            const wordCount = text.trim().split(/\s+/).filter(word => word.length > 0).length;
            
            // Emit editor state change only for document edits (not cursor-only updates)
            if (update.docChanged) {
              this.editorStateChange.emit({
                cursorPosition: this.getCursorPosition(),
                wordCount: wordCount,
                syntaxErrors: this.getSyntaxErrors(),
                isValidSyntax: this.getIsValidSyntax()
              });
            }
          }),
          EditorView.domEventHandlers({
            focus: () => {}
          }),
          EditorView.theme({
            '.cm-cql-reference-highlight': {
              backgroundColor: 'rgba(255, 193, 7, 0.35)'
            }
          })
        ]
      });
      
      this.editor = new EditorView({
        state: startState,
        parent: this.editorContainer()!.nativeElement
      });
      
      this.isInitializing = false;
      this.initializationRetries = 0; // Reset retry counter on success
      this.tryConsumePendingNavigation();
      
      // Update form validity signal after initialization
      this._isFormValidSignal.set(initialContent.trim().length > 0);
      
      // Update canExecute state after initialization
      this.updateCanExecute();
      
    } catch (error) {
      console.error('Failed to initialize CQL editor:', error);
      this.isInitializing = false;
    }
  }

  // IdeEditor interface implementation
  getValue(): string {
    return this.editor?.state.doc.toString() || '';
  }
  
  setValue(value: string): void {
    if (this.isInitializing) {
      return;
    }
    
    this._value = value;
    
    // Update form validity signal
    this._isFormValidSignal.set(value.trim().length > 0);
    
    if (this.editor) {
      this.editor.dispatch({
        changes: {
          from: 0,
          to: this.editor.state.doc.length,
          insert: this._value
        }
      });
    }
  }

  applyAiContent(value: string): void {
    if (!this.editor || value === this.editor.state.doc.toString()) return;
    const before = this.editor.state.doc.toString();
    let prefix = 0;
    while (prefix < before.length && prefix < value.length && before[prefix] === value[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < before.length - prefix && suffix < value.length - prefix &&
      before[before.length - 1 - suffix] === value[value.length - 1 - suffix]) suffix += 1;
    const highlightTo = Math.max(prefix, value.length - suffix);
    this.applyingAiChange = true;
    try {
      this.editor.dispatch({
        changes: { from: 0, to: before.length, insert: value },
        effects: setAiEditHighlightEffect.of({ from: prefix, to: highlightTo }),
      });
    } finally {
      this.applyingAiChange = false;
    }
  }
  
  focus(): void {
    this.editor?.focus();
  }
  
  blur(): void {
    this.editor?.contentDOM.blur();
  }
  
  insertText(text: string): void {
    if (this.editor) {
      const selection = this.editor.state.selection.main;
      this.editor.dispatch({
        changes: {
          from: selection.from,
          to: selection.to,
          insert: text
        }
      });
    }
  }
  
  getSelection(): string {
    if (this.editor) {
      const selection = this.editor.state.selection.main;
      return this.editor.state.doc.sliceString(selection.from, selection.to);
    }
    return '';
  }
  
  replaceSelection(text: string): void {
    if (this.editor) {
      const selection = this.editor.state.selection.main;
      this.editor.dispatch({
        changes: {
          from: selection.from,
          to: selection.to,
          insert: text
        }
      });
    }
  }

  private editorContext(mode: 'selection' | 'inline', useCurrentLine: boolean): OpenCodeEditorContext | null {
    if (!this.editor) return null;
    const selection = this.editor.state.selection.main;
    let from = selection.from;
    let to = selection.to;
    if (from === to && useCurrentLine) {
      const line = this.editor.state.doc.lineAt(selection.head);
      from = line.from;
      to = line.to;
    }
    if (from === to && !useCurrentLine) return null;
    const start = this.editor.state.doc.lineAt(from);
    const end = this.editor.state.doc.lineAt(to);
    return {
      libraryId: this.libraryId(),
      file: '',
      selectedText: this.editor.state.doc.sliceString(from, to),
      startLine: start.number,
      startColumn: from - start.from,
      endLine: end.number,
      endColumn: to - end.from,
      documentRevision: this.userRevision,
      mode,
    };
  }

  private schedulePrediction(): void {
    if (!this.settingsService.settings().enableAiCodePrediction || !this.openCodeService.isAvailable() || this.readonly() || !this.editor?.hasFocus) return;
    const selection = this.editor.state.selection.main;
    if (!selection.empty) return;
    this.predictionSubscription?.unsubscribe();
    this.predictionAbort?.abort();
    const position = selection.head;
    const revision = this.userRevision;
    this.predictionSubscription = timer(900).subscribe(() => void this.loadPrediction(position, revision));
  }

  private async loadPrediction(position: number, revision: number): Promise<void> {
    const editor = this.editor;
    if (!editor || revision !== this.userRevision || editor.state.selection.main.head !== position || !editor.hasFocus) return;
    this.predictionAbort = new AbortController();
    const source = editor.state.doc.toString();
    try {
      const raw = await this.openCodeService.predictCql(
        source.slice(Math.max(0, position - 6_000), position),
        source.slice(position, position + 2_000),
        this.predictionAbort.signal
      );
      if (!this.editor || revision !== this.userRevision || this.editor.state.selection.main.head !== position) return;
      const text = this.cleanPrediction(raw);
      if (!text) return;
      this.pendingPrediction = { from: position, text, revision };
      this.editor.dispatch({ effects: setPredictionEffect.of({ from: position, text }) });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) console.debug('CQL prediction unavailable', error);
    }
  }

  private cleanPrediction(raw: string): string {
    let value = raw.replace(/^\s*```(?:cql)?\s*/i, '').replace(/\s*```\s*$/i, '');
    value = value.replace(/^<CURSOR>/i, '');
    return value.slice(0, 800);
  }

  private acceptPrediction(): boolean {
    const prediction = this.pendingPrediction;
    if (!prediction || !this.editor || prediction.revision !== this.userRevision ||
      this.editor.state.selection.main.head !== prediction.from) return false;
    this.pendingPrediction = null;
    this.editor.dispatch({
      changes: { from: prediction.from, insert: prediction.text },
      selection: { anchor: prediction.from + prediction.text.length },
      effects: setPredictionEffect.of(null),
    });
    return true;
  }

  private dismissPrediction(): boolean {
    if (!this.pendingPrediction) return false;
    this.cancelPrediction();
    return true;
  }

  private cancelPrediction(dispatch = true): void {
    this.predictionSubscription?.unsubscribe();
    this.predictionSubscription = undefined;
    this.predictionAbort?.abort();
    this.predictionAbort = undefined;
    const hadPrediction = Boolean(this.pendingPrediction);
    this.pendingPrediction = null;
    if (dispatch && hadPrediction && this.editor) this.editor.dispatch({ effects: setPredictionEffect.of(null) });
  }
  
  formatCode(): void {
    if (!this.editor) {
      return;
    }

    const code = this.getValue();
    if (!code || !code.trim()) {
      return;
    }

    // Save cursor position before formatting
    const cursorPosition = this.getCursorPosition();
    const selection = this.editor.state.selection.main;
    const cursorOffset = selection.from;
    
    // Get the line and column for cursor position tracking
    const cursorLine = cursorPosition?.line || 1;
    const cursorColumn = cursorPosition?.column || 1;

    // Format using the service (simple, reliable formatting)
    const result = this.cqlFormatterService.format(code, {
      indentSize: 2
    });

    if (!result.success) {
      // Show error to user
      console.error('Formatting failed:', result.errors);
      
      // Prepare user-friendly error messages
      const errorMessages = result.errors || [];
      
      if (errorMessages.length > 0) {
        // Emit syntax errors for display in problems panel
        this.syntaxErrors.emit(errorMessages.map(e => `Error: ${e}`));
        
        // Also update editor state
        this.editorStateChange.emit({
          cursorPosition: cursorPosition || { line: 1, column: 1 },
          wordCount: this.getWordCount() || 0,
          syntaxErrors: errorMessages.map(e => `Error: ${e}`),
          isValidSyntax: false
        });
      }
      
      // Don't format if formatting itself failed
      return;
    }

    // Calculate new cursor position
    const newCursorPosition = this.calculateNewCursorPosition(
      code,
      result.formatted,
      cursorLine,
      cursorColumn
    );

    // Set formatted code
    try {
      this.setValue(result.formatted);
      
      // Clear any previous syntax errors since formatting succeeded
      this.syntaxErrors.emit([]);
      
      // Update editor state to reflect successful formatting
      this.editorStateChange.emit({
        cursorPosition: newCursorPosition || cursorPosition || { line: 1, column: 1 },
        wordCount: this.getWordCount() || 0,
        syntaxErrors: [],
        isValidSyntax: true
      });

      requestAnimationFrame(() => {
        if (this.editor && newCursorPosition) {
          try {
            const line = this.editor.state.doc.line(newCursorPosition.line);
            const position = Math.min(
              line.from + newCursorPosition.column - 1,
              line.to
            );
            
            this.editor.dispatch({
              selection: { anchor: position, head: position },
              scrollIntoView: true
            });
            
            this.editor.focus();
          } catch (error) {
            console.warn('Failed to restore cursor position:', error);
            this.editor.focus();
          }
        }
      });
    } catch (error) {
      console.error('Error applying formatted code:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.syntaxErrors.emit([`Failed to apply formatting: ${errorMessage}`]);
    }
  }

  clearCode(): void {
    this.setValue('');
    // setValue already updates the form validity signal
  }

  validateSyntax(code: string): void {
    // Validation is now handled by the lint extension and debounced validation
    // This method is kept for backward compatibility but triggers immediate validation
    this.performValidation(code);
  }

  /**
   * Create lint source function for CodeMirror
   * Uses debouncing to avoid validating on every keystroke
   */
  private createLintSource() {
    return (view: EditorView): Promise<Diagnostic[]> => {
      const code = view.state.doc.toString();
      if (!code || !code.trim()) {
        this.currentValidationErrors = [];
        this.syntaxErrors.emit([]);
        return Promise.resolve([]);
      }

      return new Promise((resolve) => {
        this.pendingLintResolvers.push(resolve);
        this.scheduleValidationDebounce(code);
      });
    };
  }


  /**
   * Perform immediate validation (for manual validation button)
   */
  private performValidation(code: string): void {
    if (!this.editor) {
      return;
    }

    this.cancelValidationDebounce();
    void this.runImmediateValidation(code);
  }

  private async runImmediateValidation(code: string): Promise<void> {
    if (!this.editor) {
      return;
    }

    const generation = ++this.validationGeneration;
    const diagnostics = await this.collectLintDiagnosticsAsync(code, this.editor.state.doc);
    if (generation !== this.validationGeneration) {
      return;
    }

    this.emitValidationUi(diagnostics.compilerResult, diagnostics.charDiagnostics);
    this.updateDefinitionIndex(diagnostics.compilerResult);
    this.editor.dispatch({ effects: [] });
  }

  private updateDefinitionIndex(full: FullValidationResult): void {
    this.definitionIndex = this.definitionIndexService.buildIndex(full.raw.elmXml);
    this.definitionIndexDirty = this.definitionIndex == null;
    if (this.definitionIndex) {
      this.expressions.set(expressionDefinitions(this.definitionIndex));
    }
    this.hoverTypeInfos = extractElmHoverTypeInfos(full.raw.elmXml ?? '');
    if (this.definitionIndex) {
      this.applyTerminologyIndex(
        buildTerminologySymbolIndexFromElm(this.definitionIndex, this.getValue()),
        true
      );
    } else {
      // Failed/incomplete translation: keep declaration hits from source, drop stale ELM uses.
      this.applyTerminologyIndex(buildTerminologySymbolIndex(this.getValue()), false);
    }
    if (this.editor) {
      reconfigureDefinitionIndex(this.editor, this.definitionIndex);
    }
  }

  /**
   * Edits invalidate ELM locators for rename, but keep the last index for find-refs/go-to
   * until the next validation pass (stale-while-revalidate).
   * Must not synchronously EditorView.dispatch from a docChanged updateListener.
   */
  private invalidateElmDerivedNavigation(source: string): void {
    this.definitionIndexDirty = true;
    this.applyTerminologyIndex(buildTerminologySymbolIndex(source), false);
    if (this.renameModalOpen()) {
      this.renameModalOpen.set(false);
    }
    // Peek is terminology data (not ELM locators); keep it across edits.
    this.findReferencesResultChange.emit(null);
    queueMicrotask(() => {
      if (this.editor && this.definitionIndexDirty) {
        reconfigureDefinitionIndex(this.editor, this.definitionIndex);
      }
    });
  }

  private rebuildTerminologyIndex(source: string): void {
    // Doc edits invalidate ELM locators; use source declarations until the next successful validation.
    this.applyTerminologyIndex(buildTerminologySymbolIndex(source), false);
  }

  private applyTerminologyIndex(
    index: CqlTerminologySymbolIndex,
    prefetchExistence: boolean
  ): void {
    this.terminologyIndex = index;
    if (!prefetchExistence) {
      return;
    }
    for (const declaration of this.terminologyIndex.declarations) {
      if (!declaration.url.trim()) {
        continue;
      }
      void this.terminologyExistence.resolve(declaration.kind, declaration.url);
    }
  }

  private createEditorActionsHandlers() {
    return {
      findActionsAt: (line: number, column: number): CqlEditorAction[] => {
        return this.collectActionsAt(line, column);
      },
      getHoverInfoAt: (line: number, column: number): string | null => {
        return this.getHoverInfoText(line, column);
      },
      findUnderlineSpanAt: (line: number, column: number) => {
        return this.findUnderlineSpanAt(line, column);
      }
    };
  }

  private collectActionsAt(line: number, column: number): CqlEditorAction[] {
    const actions: CqlEditorAction[] = [];

    if (this.definitionIndex) {
      const match = this.definitionIndexService.findReferenceAt(this.definitionIndex, line, column);
      if (match && isReferenceResolvableSync(match, this.definitionIndex)) {
        actions.push({
          id: 'go-to-definition',
          label: 'Go to Definition',
          run: () => this.handleGoToDefinition(line, column)
        });
      }

      const symbol = this.resolveLocalSymbolAt(line, column);
      if (symbol) {
        actions.push({
          id: 'find-references',
          label: 'Find All References',
          run: () => this.findReferencesForSymbol(symbol.name, symbol.kind)
        });
        if (symbol.kind === 'expression' || symbol.kind === 'function') {
          actions.push({
            id: 'rename-symbol',
            label: 'Rename Symbol',
            run: () => this.openRenameModal(symbol.name, symbol.kind)
          });
        }
      }
    }

    const terminology = findTerminologySymbolAt(this.terminologyIndex, line, column);
    if (terminology) {
      const cached = this.terminologyExistence.getCached(
        terminology.declaration.kind,
        terminology.declaration.url
      );
      // Prefetch existence for hover status / underline, but do not gate actions on it.
      if (cached === undefined) {
        void this.terminologyExistence.resolve(
          terminology.declaration.kind,
          terminology.declaration.url
        );
      }
      const resourceId = cached?.id || provisionalFhirIdFromUrl(terminology.declaration.url);
      const resourceUrl = cached?.url || terminology.declaration.url;
      const knownLocalId = cached?.id ?? null;

      actions.push({
        id: 'open-terminology',
        label: 'Open in Terminology Browser',
        run: () => this.openTerminology(terminology.declaration.kind, resourceId, resourceUrl)
      });
      if (terminology.declaration.kind === 'ValueSet') {
        actions.push({
          id: 'peek-valueset',
          label: 'Peek ValueSet Expansion',
          run: () => this.peekValueset(terminology.declaration.name, knownLocalId, resourceUrl)
        });
      }

      if (!actions.some(a => a.id === 'find-references')) {
        actions.push({
          id: 'find-references',
          label: 'Find All References',
          run: () => this.findTerminologyReferences(terminology.declaration.name)
        });
      }
    }

    return actions;
  }

  private findUnderlineSpanAt(line: number, column: number): { from: number; to: number } | null {
    if (!this.editor) {
      return null;
    }
    if (this.definitionIndex) {
      const match = this.definitionIndexService.findReferenceAt(this.definitionIndex, line, column);
      if (match && isReferenceResolvableSync(match, this.definitionIndex)) {
        return this.spanToOffsets(match.reference.span);
      }
    }
    const terminology = findTerminologySymbolAt(this.terminologyIndex, line, column);
    if (terminology) {
      return this.spanToOffsets(terminology.span);
    }
    return null;
  }

  private spanToOffsets(span: { startLine: number; startColumn: number; endLine: number; endColumn: number }): { from: number; to: number } | null {
    if (!this.editor) {
      return null;
    }
    try {
      const startLine = this.editor.state.doc.line(span.startLine);
      const endLine = this.editor.state.doc.line(span.endLine);
      const from = startLine.from + Math.min(Math.max(0, span.startColumn - 1), startLine.length);
      const to = endLine.from + Math.min(Math.max(0, span.endColumn), endLine.length);
      if (from >= to) {
        return null;
      }
      return { from, to };
    } catch {
      return null;
    }
  }

  private resolveLocalSymbolAt(
    line: number,
    column: number
  ): { name: string; kind: 'expression' | 'function' | 'context' } | null {
    if (!this.definitionIndex) {
      return null;
    }
    const match = this.definitionIndexService.findReferenceAt(this.definitionIndex, line, column);
    if (match?.reference.name && !match.reference.libraryName) {
      if (match.reference.kind === 'functionRef') {
        return { name: match.reference.name, kind: 'function' };
      }
      if (match.reference.kind === 'expressionRef') {
        return { name: match.reference.name, kind: 'expression' };
      }
    }

    const source = this.getValue();
    for (const defs of this.definitionIndex.definitions.values()) {
      for (const def of defs) {
        if (def.kind !== 'expression' && def.kind !== 'function') {
          continue;
        }
        const nameSpan = findDefineNameTokenSpan(source, def);
        if (nameSpan && positionContains(nameSpan, line, column)) {
          return { name: def.name, kind: def.kind };
        }
      }
    }
    return null;
  }

  private getHoverInfoText(line: number, column: number): string | null {
    const terminology = findTerminologySymbolAt(this.terminologyIndex, line, column);
    if (terminology) {
      const exists = this.terminologyExistence.getCached(
        terminology.declaration.kind,
        terminology.declaration.url
      );
      const status =
        exists === undefined ? 'checking…' : exists ? 'available on terminology server' : 'not found on terminology server';
      return `${terminology.declaration.kind} ${terminology.declaration.name}\n${terminology.declaration.url}\n(${status})`;
    }

    const symbol = this.resolveLocalSymbolAt(line, column);
    if (!symbol) {
      return null;
    }
    const infos = this.hoverTypeInfos.get(symbol.name) ?? [];
    const info = infos.find(i => i.kind === symbol.kind) ?? infos[0];
    if (info) {
      return formatHoverTypeInfo(info);
    }
    return `${symbol.kind} ${symbol.name}`;
  }

  private findReferencesAt(line: number, column: number): void {
    const symbol = this.resolveLocalSymbolAt(line, column);
    if (symbol) {
      this.findReferencesForSymbol(symbol.name, symbol.kind);
      return;
    }
    const terminology = findTerminologySymbolAt(this.terminologyIndex, line, column);
    if (terminology) {
      this.findTerminologyReferences(terminology.declaration.name);
    }
  }

  private findReferencesForSymbol(name: string, kind?: 'expression' | 'function' | 'context'): void {
    if (!this.editor) {
      return;
    }
    if (!this.definitionIndex) {
      this.publishFindReferencesResult({
        symbolName: name,
        locations: []
      });
      return;
    }
    const source = this.getValue();
    const locations: Array<{
      line: number;
      column: number;
      endLine: number;
      endColumn: number;
      preview: string;
      kind: string;
    }> = [];

    const def = findDefinition(this.definitionIndex, name, kind === 'context' ? undefined : kind);
    if (def && def.kind !== 'context') {
      const nameSpan = findDefineNameTokenSpan(source, def);
      if (nameSpan) {
        locations.push({
          line: nameSpan.startLine,
          column: elmColumnToCodeMirror(nameSpan.startColumn),
          endLine: nameSpan.endLine,
          endColumn: nameSpan.endColumn,
          preview: this.previewAtLine(nameSpan.startLine),
          kind: 'definition'
        });
      }
    }

    for (const ref of this.definitionIndex.references) {
      if (ref.libraryName || ref.name !== name) {
        continue;
      }
      if (kind === 'function' && ref.kind !== 'functionRef') {
        continue;
      }
      if (kind === 'expression' && ref.kind !== 'expressionRef') {
        continue;
      }
      locations.push({
        line: ref.span.startLine,
        column: elmColumnToCodeMirror(ref.span.startColumn),
        endLine: ref.span.endLine,
        endColumn: ref.span.endColumn,
        preview: this.previewAtLine(ref.span.startLine),
        kind: ref.kind
      });
    }

    this.publishFindReferencesResult({ symbolName: name, locations });
    this.applyReferenceHighlights(locations.map(l => ({
      startLine: l.line,
      startColumn: l.column + 1,
      endLine: l.endLine,
      endColumn: l.endColumn
    })));
  }

  private findTerminologyReferences(name: string): void {
    const declaration = this.terminologyIndex.byName.get(name);
    if (!declaration) {
      this.publishFindReferencesResult({
        symbolName: name,
        locations: []
      });
      return;
    }
    const locations = [
      {
        line: declaration.nameSpan.startLine,
        column: elmColumnToCodeMirror(declaration.nameSpan.startColumn),
        endLine: declaration.nameSpan.endLine,
        endColumn: declaration.nameSpan.endColumn,
        preview: this.previewAtLine(declaration.nameSpan.startLine),
        kind: 'declaration'
      },
      ...this.terminologyIndex.nameUses
        .filter(u => u.name === name)
        .map(u => ({
          line: u.span.startLine,
          column: elmColumnToCodeMirror(u.span.startColumn),
          endLine: u.span.endLine,
          endColumn: u.span.endColumn,
          preview: this.previewAtLine(u.span.startLine),
          kind: 'use'
        }))
    ];
    this.publishFindReferencesResult({ symbolName: name, locations });
    this.applyReferenceHighlights([
      declaration.nameSpan,
      ...this.terminologyIndex.nameUses.filter(u => u.name === name).map(u => u.span)
    ]);
  }

  private publishFindReferencesResult(result: IdeFindReferencesResult): void {
    // Angular output bindings schedule zoneless CD (same path as syntaxErrors).
    this.findReferencesResultChange.emit(result);
  }

  private applyReferenceHighlights(
    spans: Array<{ startLine: number; startColumn: number; endLine: number; endColumn: number }>
  ): void {
    if (!this.editor) {
      return;
    }
    const decorations = [];
    for (const span of spans) {
      const offsets = this.spanToOffsets(span);
      if (!offsets) {
        continue;
      }
      decorations.push(Decoration.mark({ class: 'cm-cql-reference-highlight' }).range(offsets.from, offsets.to));
    }
    this.editor.dispatch({
      effects: setReferenceHighlightEffect.of(Decoration.set(decorations, true))
    });
  }

  private previewAtLine(lineNumber: number): string {
    try {
      return this.editor?.state.doc.line(lineNumber).text.trim() ?? '';
    } catch {
      return '';
    }
  }

  private async openTerminology(
    resourceType: 'ValueSet' | 'CodeSystem',
    id: string,
    url: string
  ): Promise<void> {
    await this.terminologyOpener.requestOpen({
      resourceType,
      id: id || provisionalFhirIdFromUrl(url),
      url
    });
  }

  private async peekValueset(name: string, id: string | null, url: string): Promise<void> {
    const peekLimit = 50;
    try {
      const expanded = await firstValueFrom(
        this.terminologyService.expandValueSet({
          // Only use a server id when existence confirmed it; OID path segments fail $expand.
          id: id || undefined,
          url,
          count: peekLimit
        })
      );
      const contains = expanded.expansion?.contains ?? [];
      const codes = contains.slice(0, peekLimit);
      const total = expanded.expansion?.total;
      this.publishValuesetPeekResult({
        name,
        url,
        id: expanded.id || id || provisionalFhirIdFromUrl(url),
        codes: codes.map(c => ({
          system: c.system,
          code: c.code,
          display: c.display
        })),
        truncated: total != null ? total > codes.length : contains.length >= peekLimit
      });
    } catch (error) {
      this.publishValuesetPeekResult({
        name,
        url,
        id: id || provisionalFhirIdFromUrl(url),
        codes: [],
        truncated: false,
        error: describeFhirHttpFailure(error) || 'Failed to expand ValueSet'
      });
    }
  }

  private publishValuesetPeekResult(result: IdeValuesetPeekResult): void {
    this.valuesetPeekResultChange.emit(result);
  }

  private openRenameModal(oldName: string, kind: 'expression' | 'function' | 'context'): void {
    if (kind === 'context' || this.readonly()) {
      return;
    }
    this.renameKind = kind;
    this.renameOldName.set(oldName);
    this.renameModalOpen.set(true);
  }

  protected onRenameCancel(): void {
    this.renameModalOpen.set(false);
  }

  protected onRenameConfirm(newName: string): void {
    this.renameModalOpen.set(false);
    this.applyRename(this.renameOldName(), newName, this.renameKind);
  }

  private applyRename(
    oldName: string,
    newName: string,
    kind?: 'expression' | 'function'
  ): void {
    if (!this.editor || !this.definitionIndex || this.definitionIndexDirty || this.readonly()) {
      return;
    }
    const source = this.getValue();
    const spans = collectLocalRenameSpans(source, this.definitionIndex, oldName, kind);
    if (spans.length === 0) {
      return;
    }

    const changes = spans
      .map(span => {
        const offsets = this.spanToOffsets(span);
        if (!offsets) {
          return null;
        }
        const slice = this.editor!.state.doc.sliceString(offsets.from, offsets.to);
        return {
          from: offsets.from,
          to: offsets.to,
          insert: formatRenameReplacement(oldName, newName, slice)
        };
      })
      .filter((c): c is { from: number; to: number; insert: string } => c != null)
      .sort((a, b) => b.from - a.from);

    this.editor.dispatch({ changes });
  }

  private async handleGoToDefinition(line: number, column: number): Promise<void> {
    if (!this.definitionIndex || !this.editor) {
      return;
    }

    const match = this.definitionIndexService.findReferenceAt(this.definitionIndex, line, column);
    if (!match) {
      return;
    }

    const target = await this.definitionIndexService.resolveDefinitionTargetAsync(match, this.definitionIndex);
    if (!target) {
      return;
    }

    if (target.crossLibrary && target.includeRef) {
      const libraryId = await this.libraryOpenerService.openIncludedLibrary(target.includeRef);
      if (!libraryId) {
        return;
      }
      this.ideStateService.requestNavigateToDefinition({
        libraryId,
        line: target.span.startLine,
        column: elmColumnToCodeMirror(target.span.startColumn)
      });
      return;
    }

    this.navigateToPosition(
      target.span.startLine,
      elmColumnToCodeMirror(target.span.startColumn)
    );
  }

  private tryConsumePendingNavigation(): void {
    const pending = this.ideStateService.peekPendingEditorNavigation();
    if (!pending || pending.libraryId !== this.libraryId() || !this.editor) {
      return;
    }

    const resource = this.ideStateService.libraryResources().find(lib => lib.id === pending.libraryId);
    if (resource?.contentLoading || resource?.contentLoadError) {
      return;
    }

    const navigation = this.ideStateService.consumePendingEditorNavigation();
    if (navigation) {
      this.navigateToPosition(navigation.line, navigation.column);
    }
  }

  private getLibraryTranslationContext() {
    const library = this.ideStateService.libraryResources().find(lib => lib.id === this.libraryId());
    return this.libraryTranslationContextBuilder.fromLibraryResource(library);
  }

  private async collectLintDiagnosticsAsync(
    code: string,
    doc: { line: (lineNumber: number) => { from: number; to: number }; lineAt: (pos: number) => { number: number } }
  ): Promise<{ all: Diagnostic[]; compilerResult: FullValidationResult; charDiagnostics: Diagnostic[] }> {
    const charDiagnostics = scanInvalidCqlCharacters(code, doc);
    const full = await this.cqlValidationService.runFullValidationAsync(code, doc, this.getLibraryTranslationContext());
    const compilerDiagnostics = this.compilerValidationToDiagnostics(full.validation);
    return {
      all: [...charDiagnostics, ...compilerDiagnostics],
      compilerResult: full,
      charDiagnostics
    };
  }

  private compilerValidationToDiagnostics(validation: ValidationResult): Diagnostic[] {
    return [
      ...validation.errors.map(err => ({
        from: err.from,
        to: err.to,
        severity: 'error' as const,
        message: err.message
      })),
      ...validation.warnings.map(warn => ({
        from: warn.from,
        to: warn.to,
        severity: 'warning' as const,
        message: warn.message
      }))
    ];
  }

  private withAiFixAction(diagnostic: Diagnostic): Diagnostic {
    if (diagnostic.severity !== 'error' || this.readonly() || !this.openCodeService.isAvailable()) {
      return diagnostic;
    }
    return {
      ...diagnostic,
      actions: [
        ...(diagnostic.actions ?? []),
        {
          name: 'Fix with AI',
          apply: (view, from, to) => {
            this.diagnosticAiFixRequested.emit(buildCqlAiDiagnosticFixRequest({
              doc: view.state.doc,
              libraryId: this.libraryId(),
              userRevision: this.userRevision,
              message: diagnostic.message,
              from,
              to,
            }));
          },
        },
      ],
    };
  }

  private cancelValidationDebounce(): void {
    if (this.validationDebounceFrame !== undefined) {
      cancelAnimationFrame(this.validationDebounceFrame);
      this.validationDebounceFrame = undefined;
    }
  }

  private scheduleValidationDebounce(fallbackCode: string): void {
    this.cancelValidationDebounce();
    const deadline = performance.now() + this.VALIDATION_DEBOUNCE_MS;
    const tick = (): void => {
      if (performance.now() >= deadline) {
        this.validationDebounceFrame = undefined;
        this.runDebouncedValidation(fallbackCode);
      } else {
        this.validationDebounceFrame = requestAnimationFrame(tick);
      }
    };
    this.validationDebounceFrame = requestAnimationFrame(tick);
  }

  private runDebouncedValidation(fallbackCode: string): void {
    void this.runDebouncedValidationAsync(fallbackCode);
  }

  private async runDebouncedValidationAsync(fallbackCode: string): Promise<void> {
    const generation = ++this.validationGeneration;
    try {
      const latestCode = this.editor?.state.doc.toString() || fallbackCode;
      const latestDoc = this.editor?.state.doc;

      if (!latestDoc) {
        const resolvers = this.pendingLintResolvers;
        this.pendingLintResolvers = [];
        resolvers.forEach(r => r([]));
        return;
      }

      const diagnostics = await this.collectLintDiagnosticsAsync(latestCode, latestDoc);
      if (generation !== this.validationGeneration) {
        const resolvers = this.pendingLintResolvers;
        this.pendingLintResolvers = [];
        resolvers.forEach(r => r([]));
        return;
      }

      this.emitValidationUi(diagnostics.compilerResult, diagnostics.charDiagnostics);
      this.updateDefinitionIndex(diagnostics.compilerResult);

      const resolvers = this.pendingLintResolvers;
      this.pendingLintResolvers = [];
      resolvers.forEach(r => r(diagnostics.all.map(diagnostic => this.withAiFixAction(diagnostic))));
    } catch (error) {
      console.error('Validation error:', error);
      const resolvers = this.pendingLintResolvers;
      this.pendingLintResolvers = [];
      resolvers.forEach(r => r([]));
    }
  }

  private emitValidationUi(full: FullValidationResult, charDiagnostics: Diagnostic[] = []): void {
    if (!this.canEmitOutputs()) {
      return;
    }
    const compilerMessages = this.cqlValidationService.formatProblemsPanelMessages(full);
    const characterMessages = formatCharacterDiagnosticsForProblems(
      charDiagnostics,
      this.editor?.state.doc ?? { lineAt: () => ({ number: 1 }) }
    );
    this.currentValidationErrors = [...compilerMessages, ...characterMessages];
    this.syntaxErrors.emit(this.currentValidationErrors);
    if (this.editor) {
      this.editorStateChange.emit({
        cursorPosition: this.getCursorPosition(),
        wordCount: this.getWordCount(),
        syntaxErrors: this.currentValidationErrors,
        isValidSyntax: problemsIndicateValidSyntax(this.currentValidationErrors)
      });
    }
  }

  navigateToLine(lineNumber: number): void {
    this.navigateToPosition(lineNumber, 0);
  }

  navigateToPosition(lineNumber: number, column = 0): void {
    if (!this.editor) {
      console.warn('Editor not available for navigation');
      return;
    }

    try {
      const line = this.editor.state.doc.line(lineNumber);
      const columnOffset = Math.max(0, Math.min(column, line.length));
      const position = line.from + columnOffset;

      this.editor.dispatch({
        selection: { anchor: position, head: position },
        scrollIntoView: true
      });

      this.editor.focus();
    } catch (error) {
      console.error(`Failed to navigate to line ${lineNumber}:`, error);
    }
  }

  // Private helper methods

  private reinitializeEditor(): void {
    if (this.editor && !this.isInitializing) {
      const currentValue = this.getValue();
      this.teardownEditor();
      this.isInitializing = false; // Reset flag
      this.initializeEditor();
      // Set value immediately after initialization
      if (this.editor) {
        this.setValue(currentValue);
      }
    }
  }

  /**
   * Calculate new cursor position after formatting
   * Attempts to preserve cursor position relative to the content
   */
  private calculateNewCursorPosition(
    originalCode: string,
    formattedCode: string,
    originalLine: number,
    originalColumn: number
  ): { line: number; column: number } | null {
    try {
      const originalLines = originalCode.split('\n');
      const formattedLines = formattedCode.split('\n');

      // If cursor is beyond the document, place at end
      if (originalLine > originalLines.length) {
        const lastLine = formattedLines[formattedLines.length - 1] || '';
        return {
          line: formattedLines.length,
          column: lastLine.length + 1
        };
      }

      // Get the original line content up to the cursor
      const originalLineContent = originalLines[originalLine - 1] || '';
      const textBeforeCursor = originalLineContent.substring(0, originalColumn - 1);

      // Try to find the same text in the formatted code
      // First, try to find the same line number
      if (originalLine <= formattedLines.length) {
        const formattedLineContent = formattedLines[originalLine - 1];
        
        // Try to find the position in the formatted line
        // Simple approach: find the same text pattern
        const searchText = textBeforeCursor.trim();
        if (searchText) {
          const index = formattedLineContent.indexOf(searchText);
          if (index >= 0) {
            return {
              line: originalLine,
              column: index + searchText.length + 1
            };
          }
        }

        // Fallback: use the same column if line exists
        return {
          line: originalLine,
          column: Math.min(originalColumn, formattedLineContent.length + 1)
        };
      }

      // If line doesn't exist in formatted code, place at end
      const lastLine = formattedLines[formattedLines.length - 1] || '';
      return {
        line: formattedLines.length,
        column: lastLine.length + 1
      };
    } catch (error) {
      console.warn('Error calculating cursor position:', error);
      return null;
    }
  }

  private setupResizeObserver(): void {
    if (!this.editorContainer()?.nativeElement || this.editor) {
      return;
    }

    this.resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0 && !this.editor && !this.isInitializing) {
          this.initializeEditor();
          this.resizeObserver?.disconnect();
        }
      }
    });

    this.resizeObserver.observe(this.editorContainer()!.nativeElement);
  }

  private getCursorPosition(): { line: number; column: number } | undefined {
    if (!this.editor) return undefined;
    
    const selection = this.editor.state.selection.main;
    const line = this.editor.state.doc.lineAt(selection.from).number;
    const column = selection.from - this.editor.state.doc.lineAt(selection.from).from;
    return { line, column };
  }

  private getWordCount(): number | undefined {
    if (!this.editor) return undefined;
    
    const text = this.editor.state.doc.toString();
    return text.trim().split(/\s+/).filter(word => word.length > 0).length;
  }

  private getSyntaxErrors(): string[] {
    return this.currentValidationErrors;
  }

  getCurrentSyntaxErrors(): string[] {
    return this.currentValidationErrors;
  }

  refreshLayout(): void {
    if (!this.editor || this.viewDestroyed) {
      return;
    }
    this.editor.requestMeasure();
  }

  private getIsValidSyntax(): boolean {
    return problemsIndicateValidSyntax(this.currentValidationErrors);
  }

  // Toolbar methods
  
  // Update the canExecute signal
  private updateCanExecute(): void {
    // Get content for this specific library
    const currentContent = this.getLibraryContent();
    const hasContent = currentContent.trim().length > 0;
    if (!hasContent) {
      this._canExecuteSignal.set(false);
      return;
    }
    
    // Get the library resource for this editor
    const library = this.ideStateService.libraryResources().find(lib => lib.id === this.libraryId());
    if (!library) {
      this._canExecuteSignal.set(false);
      return;
    }
    
    // More robust dirty check - normalize whitespace and line endings
    const normalizedCurrent = this.normalizeContent(currentContent);
    const normalizedOriginal = this.normalizeContent(library.originalContent);
    const isDirty = normalizedCurrent !== normalizedOriginal;
    if (isDirty) {
      this._canExecuteSignal.set(false);
      return;
    }
    if (this.executionScope() === 'custom' && this.selectedExpressionNames().size === 0) {
      this._canExecuteSignal.set(false);
      return;
    }

    this._canExecuteSignal.set(true);
  }



  onExecuteLibrary(): void {
    this.executeLibrary.emit();
  }

  getEvaluateExpressions(): string[] | undefined {
    if (this.executionScope() !== 'custom') {
      return undefined;
    }
    const selected = this.selectedExpressionNames();
    return this.sortedExpressions()
      .filter(expression => selected.has(expression.name))
      .map(expression => expression.name);
  }

  protected setExecutionScope(scope: 'all' | 'custom'): void {
    this.executionScope.set(scope);
    this.updateCanExecute();
  }

  protected isExpressionSelected(name: string): boolean {
    return this.selectedExpressionNames().has(name);
  }

  protected toggleExpression(name: string, checked: boolean): void {
    if (this.executionScope() === 'all') {
      return;
    }
    this.selectedExpressionNames.update(current => {
      const next = new Set(current);
      if (checked) {
        next.add(name);
      } else {
        next.delete(name);
      }
      return next;
    });
    this.updateCanExecute();
  }

  protected onExpressionCheckboxChange(name: string, event: Event): void {
    const input = event.target as HTMLInputElement | null;
    this.toggleExpression(name, !!input?.checked);
  }

  protected selectAllExpressions(): void {
    if (this.executionScope() !== 'custom') {
      return;
    }
    this.selectedExpressionNames.set(new Set(this.expressions().map(expression => expression.name)));
    this.updateCanExecute();
  }

  protected selectNoExpressions(): void {
    if (this.executionScope() !== 'custom') {
      return;
    }
    this.selectedExpressionNames.set(new Set());
    this.updateCanExecute();
  }

  onReloadLibrary(): void {
    this.reloadLibrary.emit();
  }

  onFormatCql(): void {
    this.formatCode();
  }

  onValidateCql(): void {
    // Trigger immediate validation
    const code = this.getValue();
    if (code) {
      this.performValidation(code);
    }
    this.validateCql.emit();
  }

  onSaveLibrary(): void {
    this.saveLibrary.emit();
  }


  // Method to manually update the canExecute signal
  invalidateCanExecuteCache(): void {
    this.updateCanExecute();
  }

  // Method to normalize content for comparison (handles whitespace, line endings, etc.)
  private normalizeContent(content: string): string {
    if (!content) return '';
    
    return content
      .replace(/\r\n/g, '\n')  // Normalize line endings to LF
      .replace(/\r/g, '\n')    // Handle old Mac line endings
      .replace(/\n\s*\n/g, '\n') // Remove empty lines
      .trim(); // Remove leading/trailing whitespace
  }
}
