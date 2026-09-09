// Author: Preston Lee

import { Component, ChangeDetectionStrategy, OnInit, OnDestroy, viewChild, viewChildren, effect, inject, ElementRef, untracked } from '@angular/core';
import { Router } from '@angular/router';
import {
  IdeFindReferencesResult,
  IdeStateService,
  IdeValuesetPeekResult
} from '../../services/ide-state.service';
import { IdeTabRegistryService } from '../../services/ide-tab-registry.service';
import { problemsIndicateValidSyntax, formatCharacterDiagnosticsForProblems } from '../../services/cql-problems-message.lib';
import { scanInvalidCqlCharacters } from '../../services/cql-character-lint.lib';
import { LibraryService } from '../../services/library.service';
import { IdeContextService } from '../../services/ide-context.service';
import { TranslationService } from '../../services/translation.service';
import { LibraryTranslationContextBuilder } from '../../services/library-translation-context.lib';
import { CqlExecutionService } from '../../services/cql-execution.service';
import { SettingsService } from '../../services/settings.service';
import { OpenCodeLibraryWorkspaceService } from '../../services/opencode-library-workspace.service';
import { OpenCodeService } from '../../services/opencode.service';
import { OpenCodeEditorBridgeService } from '../../services/opencode-editor-bridge.service';
import { OpenCodeEditorContext, OpenCodeLibraryChange } from '../../models/opencode.model';
import { CqlValidationService } from '../../services/cql-validation.service';
import { ToastService } from '../../services/toast.service';
import {
  CqlIdeLibraryOpenerService,
  PendingLibraryOpen,
} from '../../services/cql-ide-library-opener.service';
import type { Library } from 'fhir/r4';
import type { LibraryResource } from './shared/ide-types';
import { firstValueFrom } from 'rxjs';
import { IdeExecutionSubject } from '../../models/ide-context.model';
import { encodeUtf8Base64 } from '../../services/utf8-encoding.lib';
import {
  buildSeparateExecutionOutputSections,
  normalizeExecutionResults,
  shouldRenderExecutionResultsSeparately
} from '../../services/cql-execution-output.lib';
import {
  getAllShortcuts as buildAllShortcuts,
  isMacPlatform as detectMacPlatform
} from './cql-ide-shortcuts.lib';
import { CqlAiDiagnosticFixRequest } from '../../services/cql-ai-diagnostic-fix.lib';
import { extractVsacCanonicalUrls, OpenCodeVsacImportService } from '../../services/opencode-vsac-import.service';

// Import all the new components
import { IdeStatusBarComponent } from './ide-status-bar/ide-status-bar.component';
import { IdePanelComponent } from './panels/ide-panel.component';
import { CqlEditorComponent } from './editors/cql-editor/cql-editor.component';
import { EditorTabsComponent } from './editors/editor-tabs/editor-tabs.component';

@Component({
  selector: 'app-cql-ide',
  imports: [
    IdeStatusBarComponent,
    IdePanelComponent,
    CqlEditorComponent,
    EditorTabsComponent
  ],
  templateUrl: './cql-ide.component.html',

  styleUrls: ['./cql-ide.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown)': 'handleKeyboardShortcuts($event)',
  },
})
export class CqlIdeComponent implements OnInit, OnDestroy {
  private static readonly MAIN_CONTENT_MIN_WIDTH_PX = 200;

  cqlEditors = viewChildren(CqlEditorComponent);
  ideLayoutRef = viewChild<ElementRef<HTMLElement>>('ideLayout');

  private router = inject(Router);
  public ideStateService = inject(IdeStateService);
  public ideTabRegistryService = inject(IdeTabRegistryService);
  private libraryService = inject(LibraryService);
  protected readonly ideContextService = inject(IdeContextService);
  private translationService = inject(TranslationService);
  private libraryTranslationContextBuilder = inject(LibraryTranslationContextBuilder);
  private cqlExecutionService = inject(CqlExecutionService);
  public settingsService = inject(SettingsService);
  private readonly openCodeLibraryWorkspace = inject(OpenCodeLibraryWorkspaceService);
  private openCodeService = inject(OpenCodeService);
  private openCodeEditorBridge = inject(OpenCodeEditorBridgeService);
  private cqlValidationService = inject(CqlValidationService);
  private toastService = inject(ToastService);
  private libraryOpenerService = inject(CqlIdeLibraryOpenerService);
  private openCodeVsacImport = inject(OpenCodeVsacImportService);

  constructor() {
    effect(() => {
      const activeId = this.ideStateService.activeLibraryId();
      const active = this.ideStateService.libraryResources().find(library => library.id === activeId);
      if (!active) return;
      untracked(() => {
        const current = this.openCodeEditorBridge.document();
        const revision = this.openCodeEditorBridge.documents().get(active.id)?.userRevision ?? 0;
        if (current?.libraryId !== active.id || current.content !== active.cqlContent) {
          this.openCodeEditorBridge.recordDocument(active.id, active.cqlContent, revision);
        }
      });
    });

    // Watch for editor action requests from tool orchestrator (effect must be in constructor)
    effect(() => {
      const lineNumber = this.ideStateService.navigateToLineRequest();
      if (lineNumber !== null) {
        this.onNavigateToLine(lineNumber);
      }
    });
    
    effect(() => {
      const shouldFormat = this.ideStateService.formatCodeRequest();
      if (shouldFormat) {
        this.onFormatCql();
      }
    });

    effect(() => {
      const pending = this.libraryOpenerService.pendingOpen();
      if (!pending) {
        return;
      }
      untracked(() => {
        const request = this.libraryOpenerService.consumePendingOpen();
        if (!request) {
          return;
        }
        void this.openPendingLibrary(request);
      });
    });
  }

  private async openPendingLibrary(request: PendingLibraryOpen): Promise<void> {
    const opened = await this.libraryOpenerService.openLibraryFromServer(
      request.library,
      request.workspaceOrigin
    );
    if (!opened) {
      this.toastService.showError(
        `Could not open Library/${request.library.id} in the CQL IDE.`,
        'Open Failed'
      );
    }
  }

  ngOnInit(): void {
    this.initializeDefaultTabs();
    
    // Update AI tab availability when settings change
    // Note: We'll call updateAiTabAvailability() when settings are updated
    // This could be improved with a proper signal-based approach in the future
  }

  ngOnDestroy(): void {
    // Clean up tabs and state when component is destroyed
    this.cleanupTabs();
  }

  private initializeDefaultTabs(): void {
    // Check if tabs already exist to prevent duplicates
    const leftPanel = this.ideStateService.getPanel('left');
    const rightPanel = this.ideStateService.getPanel('right');
    const bottomPanel = this.ideStateService.getPanel('bottom');
    
    if (leftPanel && leftPanel.tabs.length > 0 && 
        rightPanel && rightPanel.tabs.length > 0 && 
        bottomPanel && bottomPanel.tabs.length > 0) {
      return;
    }

    // Add default tabs to panels
    const navigationTab = {
      id: 'navigation-tab',
      title: 'Navigation',
      icon: 'bi-list',
      type: 'navigation',
      isActive: true,
      isClosable: false,
      component: null
    };

    const outlineTab = {
      id: 'outline-tab',
      title: 'Outline',
      icon: 'bi-diagram-3',
      type: 'outline',
      isActive: false,
      isClosable: true,
      component: null
    };

    const fhirTab = {
      id: 'fhir-tab',
      title: 'FHIR',
      icon: 'bi-heart-pulse',
      type: 'fhir',
      isActive: false,
      isClosable: false,
      component: null
    };

    const elmTab = {
      id: 'elm-tab',
      title: 'ELM',
      icon: 'bi-code-slash',
      type: 'elm',
      isActive: false,
      isClosable: true,
      component: null
    };

    const clipboardTab = {
      id: 'clipboard-tab',
      title: 'Clipboard',
      icon: 'bi-clipboard',
      type: 'clipboard',
      isActive: false,
      isClosable: true,
      component: null
    };

    const aiTab = {
      id: 'ai-tab',
      title: 'OpenCode',
      icon: 'bi-terminal',
      type: 'ai',
      isActive: true,
      isClosable: true,
      component: null
    };

    const outputTab = {
      id: 'output-tab',
      title: 'Console',
      icon: 'bi-terminal',
      type: 'output',
      isActive: true,
      isClosable: true,
      component: null
    };

    const problemsTab = {
      id: 'problems-tab',
      title: 'Problems',
      icon: 'bi-exclamation-triangle',
      type: 'problems',
      isActive: false,
      isClosable: false,
      component: null
    };

    const referencesTab = {
      id: 'references-tab',
      title: 'References',
      icon: 'bi-search',
      type: 'references',
      isActive: false,
      isClosable: true,
      component: null
    };

    const valuesetPeekTab = {
      id: 'valueset-peek-tab',
      title: 'ValueSet Peek',
      icon: 'bi-collection',
      type: 'valueset-peek',
      isActive: false,
      isClosable: true,
      component: null
    };


    // Add tabs to panels
    this.ideStateService.addTabToPanel('left', navigationTab);
    this.ideStateService.addTabToPanel('left', outlineTab);
    this.ideStateService.addTabToPanel('right', fhirTab);
    this.ideStateService.addTabToPanel('right', elmTab);
    this.ideStateService.addTabToPanel('right', clipboardTab);
    
    // Only add OpenCode when CQL Studio Server and Ollama are configured and AI is enabled.
    const aiTabAdded = this.openCodeService.isAvailable();
    if (aiTabAdded) {
      this.ideStateService.addTabToPanel('right', aiTab);
    }
    
    this.ideStateService.addTabToPanel('bottom', outputTab);
    this.ideStateService.addTabToPanel('bottom', problemsTab);
    this.ideStateService.addTabToPanel('bottom', referencesTab);
    this.ideStateService.addTabToPanel('bottom', valuesetPeekTab);

    this.ideStateService.setActiveTab('left', 'navigation-tab');
    this.ideStateService.setActiveTab('bottom', 'output-tab');
    
    // Set the active tab for the right panel: AI tab if available, otherwise FHIR tab
    if (aiTabAdded) {
      this.ideStateService.setActiveTab('right', 'ai-tab');
    } else {
      this.ideStateService.setActiveTab('right', 'fhir-tab');
    }
  }

  private cleanupTabs(): void {
    // Clear all tabs from all panels
    this.ideStateService.clearPanelTabs('left');
    this.ideStateService.clearPanelTabs('right');
    this.ideStateService.clearPanelTabs('bottom');
    
    // Clear output sections
    this.ideStateService.clearOutputSections();
    
    // Reset execution state
    this.ideStateService.setExecuting(false);
    this.ideStateService.setExecutionProgress(0);
    this.ideStateService.setExecutionStatus('');
  }

  /**
   * Update OpenCode tab availability based on settings
   */
  updateAiTabAvailability(): void {
    const rightPanel = this.ideStateService.getPanel('right');
    if (!rightPanel) return;

    const hasAiTab = rightPanel.tabs.some(tab => tab.type === 'ai');
    const shouldHaveAiTab = this.openCodeService.isAvailable();

    if (shouldHaveAiTab && !hasAiTab) {
      // Add AI tab
      const aiTab = {
        id: 'ai-tab',
        title: 'OpenCode',
        icon: 'bi-terminal',
        type: 'ai',
        isActive: false,
        isClosable: true,
        component: null
      };
      this.ideStateService.addTabToPanel('right', aiTab);
    } else if (!shouldHaveAiTab && hasAiTab) {
      // Remove AI tab
      this.ideStateService.removeTabFromPanel('right', 'ai-tab');
    }
  }

  // Panel management
  onTogglePanel(panelId: string): void {
    this.ideStateService.togglePanel(panelId);
  }

  onSetActiveTab(panelId: string, tabId: string): void {
    this.ideStateService.setActiveTab(panelId, tabId);
  }

  onMoveTab(event: { tabId: string; fromPanelId: string; toPanelId: string }): void {
    this.ideStateService.moveTabToPanel(event.tabId, event.fromPanelId, event.toPanelId);
  }

  onReorderPanelTab(event: { panelId: string; fromIndex: number; toIndex: number }): void {
    this.ideStateService.reorderTabInPanel(event.panelId, event.fromIndex, event.toIndex);
  }

  onDragOver(panelId: string): void {
    this.ideStateService.setDragOverPanel(panelId);
  }

  onDragLeave(panelId: string): void {
    if (this.ideStateService.dragOverPanel() === panelId) {
      this.ideStateService.setDragOverPanel(null);
    }
  }

  // Library management
  onLibraryIdChange(libraryId: string): void {
    this.ideStateService.selectLibraryResource(libraryId);
    queueMicrotask(() => {
      const editor = this.activeCqlEditor();
      if (!editor) {
        return;
      }
      editor.refreshLayout();
      this.onEditorSyntaxErrors(editor.getCurrentSyntaxErrors(), libraryId);
    });
  }


  isActiveLibraryNew(): boolean {
    const activeLibrary = this.ideStateService.getActiveLibraryResource();
    // A library is considered "new" if it doesn't have a corresponding FHIR library object
    // or if it's marked as dirty (has unsaved changes)
    return !activeLibrary?.library || activeLibrary.isDirty;
  }



  onLibraryVersionChange(version: string): void {
    // Handle library version change
  }

  onLibraryDescriptionChange(description: string): void {
    // Handle library description change
  }

  async onSaveLibrary(options: { skipVsacImport?: boolean } = {}): Promise<void> {
    const activeLibrary = this.ideStateService.getActiveLibraryResource();
    if (!activeLibrary) {
      console.warn('No active library to save');
      return;
    }

    // Get the current content from the library resource
    const currentContent = activeLibrary.cqlContent || '';
    if (!currentContent.trim()) {
      console.warn('No content to save');
      return;
    }

    this.ideStateService.setExecutionStatus('Translating CQL to ELM...');
    this.ideStateService.setTranslating(true);

    try {
      // Translate CQL to ELM using the translation service (as if triggered from ELM tab)
      const translationResult = await this.translationService.translateCqlToElmAsync(
        currentContent,
        this.libraryTranslationContextBuilder.fromLibraryResource(activeLibrary)
      );

      // Update translation state with errors/warnings
      this.ideStateService.setTranslationErrors(translationResult.errors);
      this.ideStateService.setTranslationWarnings(translationResult.warnings);
      this.ideStateService.setTranslationMessages(translationResult.messages);

      this.ideStateService.setTranslating(false);

      // Set ELM results in state (for display in ELM tab)
      this.ideStateService.setElmTranslationResults(translationResult.elmXml);

      // Check if we have ELM XML to save (even if there are errors, we may have partial results)
      if (!translationResult.elmXml) {
        console.error('Translation failed - no ELM XML generated');
        this.ideStateService.setExecutionStatus('Translation failed - no ELM output generated');

        // Add error message to Console pane
        const libraryName = activeLibrary.name || activeLibrary.id || 'Library';
        const errorMessages = translationResult.errors.length > 0
          ? translationResult.errors.join('\n')
          : 'Translation failed to generate ELM XML';
        this.ideStateService.addTextOutput(
          `Save Failed: ${libraryName}`,
          `Failed to save library "${libraryName}" - no ELM XML was generated.\n\nErrors:\n${errorMessages}`,
          'error'
        );

        // Mark as dirty again since save failed
        this.ideStateService.updateLibraryResource(activeLibrary.id, {
          isDirty: true
        });

        // Clear error status after a short delay
        this.clearExecutionStatusAfter(5000);
        return;
      }

      // If we have ELM XML, proceed with saving (even if there are errors)
      if (translationResult.hasErrors) {
        console.warn('Translation completed with errors, but ELM XML is available. Proceeding with save.');
        this.ideStateService.setExecutionStatus('Saving library (with translation warnings)...');

        // Add warning message to Console pane (using 'error' status since there are translation errors)
        const libraryName = activeLibrary.name || activeLibrary.id || 'Library';
        const errorMessages = translationResult.errors.join('\n');
        this.ideStateService.addTextOutput(
          `Save Warning: ${libraryName}`,
          `Library "${libraryName}" saved with translation errors.\n\nErrors:\n${errorMessages}\n\nELM XML was generated and saved.`,
          'error'
        );
      } else {
        this.ideStateService.setExecutionStatus('Saving library...');
      }

      const vsacReferences = extractVsacCanonicalUrls(currentContent);
      if (vsacReferences.length > 0 && !options.skipVsacImport) {
        this.ideStateService.setExecutionStatus('Checking and importing VSAC terminology...');
        const terminology = await this.openCodeVsacImport.importForCql(currentContent);
        this.ideStateService.addTextOutput(
          `VSAC Terminology Ready: ${activeLibrary.name || activeLibrary.id}`,
          `${terminology.imported} ValueSet(s) imported and ${terminology.alreadyPresent} already present on ${terminology.target}.`,
          'success'
        );
      }

      // Update the library resource with current content
      this.ideStateService.updateLibraryResource(activeLibrary.id, {
        cqlContent: currentContent,
        isDirty: false
      });

      // Check if this is a new library (no FHIR library object) or existing library
      // Also check if the ID has changed (which requires creating a new library)
      const hasExistingLibrary = activeLibrary.library && activeLibrary.library.id;
      const idHasChanged = hasExistingLibrary && activeLibrary.library && activeLibrary.library.id !== activeLibrary.id;

      // Always include ELM XML in the Library content per FHIR Library resource specifications
      // The ELM XML is base64 encoded and included with contentType 'application/elm+xml'
      if (hasExistingLibrary && !idHasChanged) {
        // Update existing library (ID hasn't changed)
        await this.updateExistingLibrary(activeLibrary.library, currentContent, translationResult.elmXml);
      } else {
        // Create new library (either no existing library or ID has changed)
        await this.createNewLibrary(activeLibrary, currentContent, translationResult.elmXml);
      }
    } catch (error) {
      console.error('Save failed during translation:', error);
      this.ideStateService.setTranslating(false);
      this.ideStateService.setExecutionStatus('Failed to save library');
      const libraryName = activeLibrary.name || activeLibrary.id || 'Library';
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.ideStateService.addTextOutput(
        `Save Failed: ${libraryName}`,
        `Failed to save library "${libraryName}".\n\nError: ${errorMessage}`,
        'error'
      );
      this.ideStateService.updateLibraryResource(activeLibrary.id, {
        isDirty: true
      });
      this.clearExecutionStatusAfter(3000);
    }
  }

  onDeleteLibrary(libraryId: string): void {
    const resources = this.ideStateService.libraryResources();
    const wasActive = this.ideStateService.activeLibraryId() === libraryId;
    let adjacentId: string | null = null;

    if (wasActive && resources.length > 1) {
      const idx = resources.findIndex(r => r.id === libraryId);
      if (idx >= 0) {
        if (idx > 0) {
          adjacentId = resources[idx - 1].id;
        } else {
          adjacentId = resources[idx + 1].id;
        }
      }
    }

    if (wasActive && adjacentId) {
      this.ideStateService.selectLibraryResource(adjacentId);
    } else if (wasActive) {
      this.ideStateService.selectLibraryResource(null);
    }

    this.ideStateService.removeLibraryResource(libraryId);
  }

  // Translation
  onTranslateCqlToElm(): void {
    this.ideStateService.setTranslating(true);
    // Implementation for CQL to ELM translation
  }

  onClearElmTranslation(): void {
    this.ideStateService.setElmTranslationResults(null);
  }

  // Execution
  async onExecuteAll(): Promise<void> {
    this.ideStateService.setExecuting(true);
    
    // Get all library resources
    const libraries = this.ideStateService.libraryResources();
    if (libraries.length === 0) {
      this.ideStateService.setExecuting(false);
      return;
    }
    
    const subjects = this.ideContextService.getSelectedSubjects();
    
    // Prepare libraries for execution
    const librariesToExecute = libraries.map(lib => ({
      id: lib.id,
      name: lib.name || lib.id
    }));
    
    try {
      const results = await firstValueFrom(
        this.cqlExecutionService.executeAllLibraries(librariesToExecute, subjects)
      );
      this.ideStateService.setExecuting(false);
      this.formatAndAddExecutionResults(results, 'Execute All Libraries', subjects);
    } catch (error) {
      console.error('All libraries execution failed:', error);
      this.ideStateService.setExecuting(false);
      this.addErrorToOutput('Execute All Libraries', error);
    }
  }

  private activeCqlEditor(): CqlEditorComponent | undefined {
    const activeId = this.ideStateService.activeLibraryId();
    if (!activeId) {
      return undefined;
    }
    return this.cqlEditors().find((editor) => editor.libraryId() === activeId);
  }

  onNavigateToLine(lineNumber: number): void {
    // Navigate to the specified line in the active CQL editor
    const editor = this.activeCqlEditor();
    if (editor) {
      editor.navigateToLine(lineNumber);
    } else {
      console.warn('CQL editor not available for navigation');
    }
  }

  // Settings
  onPreserveLogsChange(preserveLogs: boolean): void {
    // Handle preserve logs setting change
  }

  // Additional methods needed for the template
  onStartResize(event: { type: string; event: MouseEvent; newSize?: number }): void {
    if (event.newSize === undefined) return;
    let size = event.newSize;
    const layoutEl = this.ideLayoutRef()?.nativeElement;
    if (layoutEl && (event.type === 'left' || event.type === 'right')) {
      const containerWidth = layoutEl.clientWidth;
      const leftPanel = this.ideStateService.getPanel('left');
      const rightPanel = this.ideStateService.getPanel('right');
      const leftSize = leftPanel?.isVisible ? leftPanel.size : 0;
      const rightSize = rightPanel?.isVisible ? rightPanel.size : 0;
      if (event.type === 'left') {
        const maxLeft = containerWidth - CqlIdeComponent.MAIN_CONTENT_MIN_WIDTH_PX - rightSize;
        size = Math.min(size, maxLeft);
      } else {
        const maxRight = containerWidth - leftSize - CqlIdeComponent.MAIN_CONTENT_MIN_WIDTH_PX;
        size = Math.min(size, maxRight);
      }
    }
    this.ideStateService.setPanelSize(event.type, size);
  }

  onReorderEditorTabs(event: { fromIndex: number; toIndex: number }): void {
  }

  onInsertCqlCode(code: string): void {
    const editor = this.activeCqlEditor();
    if (editor) {
      editor.insertText(code);
    } else {
      console.warn('CQL editor not available for code insertion');
    }
  }

  onReplaceCqlCode(code: string): void {
    const editor = this.activeCqlEditor();
    if (editor) {
      editor.setValue(code);
    } else {
      console.warn('CQL editor not available for code replacement');
    }
  }

  async onApplyOpenCodeChange(change: OpenCodeLibraryChange): Promise<void> {
    let library: LibraryResource;
    try { library = await this.openCodeLibraryWorkspace.open(change.libraryId); }
    catch (error) {
      change.onSaveComplete?.(false);
      this.toastService.showError(error instanceof Error ? error.message : String(error), 'OpenCode');
      return;
    }
    if (library.isReadOnly) {
      change.onSaveComplete?.(false);
      this.toastService.showError(`Library "${library.name}" is read-only.`, 'OpenCode');
      return;
    }

    if (change.mode === 'live' || change.mode === 'revert') {
      this.ideStateService.selectLibraryResource(library.id);
      const editor = this.cqlEditors().find(candidate => candidate.libraryId() === library.id);
      if (!editor) {
        this.ideStateService.updateLibraryResource(library.id, { cqlContent: change.cqlContent, isDirty: change.cqlContent !== library.originalContent });
        this.openCodeEditorBridge.recordDocument(library.id, change.cqlContent, change.baseRevision ?? 0);
        return;
      }
      editor.applyAiContent(change.cqlContent);
      return;
    }

    let elmXml: string | undefined;
    if (change.save !== false) {
      const candidate = { ...library, cqlContent: change.cqlContent, isDirty: true };
      const translation = await this.translationService.translateCqlToElmAsync(
        change.cqlContent,
        this.libraryTranslationContextBuilder.fromLibraryResource(candidate)
      );
      if (translation.hasErrors || !translation.elmXml) {
        this.ideStateService.setTranslationErrors(translation.errors);
        this.ideStateService.setTranslationWarnings(translation.warnings);
        this.ideStateService.setTranslationMessages(translation.messages);
        this.toastService.showError('The OpenCode change could not be translated and was not applied or saved.', 'OpenCode');
        this.ideStateService.addTextOutput(
          `OpenCode Save Blocked: ${library.name}`,
          translation.errors.join('\n') || 'CQL translation did not produce ELM.',
          'error'
        );
        change.onSaveComplete?.(false);
        return;
      }
      elmXml = translation.elmXml;
    }

    this.ideStateService.selectLibraryResource(library.id);
    this.ideStateService.updateLibraryResource(library.id, {
      cqlContent: change.cqlContent,
      isDirty: change.cqlContent !== library.originalContent,
    });
    this.ideStateService.triggerReload(library.id);
    if (change.save === false) {
      this.toastService.showWarning(`Applied OpenCode changes to ${library.name} locally. The library remains unsaved.`, 'OpenCode');
      return;
    }
    try {
      await this.openCodeLibraryWorkspace.save({ ...library, cqlContent: change.cqlContent }, change.cqlContent, elmXml);
      this.invalidateLibrarySourceCache(library, change.cqlContent);
      change.onSaveComplete?.(true);
      this.toastService.showSuccess(`Applied and saved OpenCode changes to ${library.name}.`, 'OpenCode');
    } catch (error) {
      change.onSaveComplete?.(false);
      this.toastService.showError(error instanceof Error ? error.message : String(error), 'OpenCode');
    }
  }

  onEditorContentChange(event: { cursorPosition: { line: number; column: number }, wordCount: number, content: string, source: 'user' | 'ai', userRevision: number }, libraryId: string): void {
    this.ideStateService.updateEditorState({
      cursorPosition: event.cursorPosition,
      wordCount: event.wordCount
    });
    
    // Update the specific library's content and dirty state
    const library = this.ideStateService.libraryResources().find(lib => lib.id === libraryId);
    if (library) {
      const currentContent = event.content;
      const isDirty = currentContent !== library.originalContent;
      
      // Update the library resource with the new content
      this.ideStateService.updateLibraryResource(libraryId, {
        cqlContent: currentContent,
        isDirty: isDirty
      });
      this.openCodeEditorBridge.recordDocument(libraryId, currentContent, event.userRevision);
    }
  }

  onEditorSelectionChange(context: OpenCodeEditorContext | null, libraryId: string): void {
    if (this.ideStateService.activeLibraryId() !== libraryId) return;
    this.openCodeEditorBridge.recordSelection(context);
  }

  onInlineAiEditRequested(context: OpenCodeEditorContext): void {
    this.openCodeEditorBridge.requestInlineEdit(context);
    this.ideStateService.activateOpenCodeTab();
  }

  onDiagnosticAiFixRequested(request: CqlAiDiagnosticFixRequest): void {
    this.openCodeEditorBridge.requestInlineEdit(request.context, {
      prompt: request.prompt,
      autoSend: true,
    });
    this.ideStateService.activateOpenCodeTab();
  }

  onEditorSyntaxErrors(errors: string[], libraryId: string): void {
    if (this.ideStateService.activeLibraryId() !== libraryId) {
      return;
    }
    this.ideStateService.updateEditorState({
      syntaxErrors: errors,
      isValidSyntax: problemsIndicateValidSyntax(errors)
    });
  }

  onFindReferencesResult(result: IdeFindReferencesResult | null): void {
    this.ideStateService.setFindReferencesResult(result);
  }

  onValuesetPeekResult(result: IdeValuesetPeekResult | null): void {
    this.ideStateService.setValuesetPeekResult(result);
  }

  // Editor toolbar methods

  async onExecuteLibrary(): Promise<void> {
    const activeLibrary = this.ideStateService.getActiveLibraryResource();
    if (!activeLibrary) {
      return;
    }
    if (activeLibrary.isDirty) {
      this.ideStateService.addTextOutput(
        'Execute Skipped',
        'Save the library before executing. Execution uses the saved version on the server.',
        'pending'
      );
      this.ideStateService.activateOutputTab();
      return;
    }

    const expressions = this.activeCqlEditor()?.getEvaluateExpressions();
    if (expressions && expressions.length === 0) {
      this.ideStateService.addTextOutput(
        'Execute Skipped',
        'Select at least one expression, or switch execution scope to All.',
        'pending'
      );
      this.ideStateService.activateOutputTab();
      return;
    }

    this.ideStateService.setExecuting(true);
    this.ideStateService.setExecutionStatus('Translating CQL to ELM...');

    const subjects = this.ideContextService.getSelectedSubjects();

    // Get current CQL content from memory (even if not saved)
    const currentCqlContent = activeLibrary.cqlContent || '';

    try {
      // Translate CQL to ELM using the translation service (similar to Save)
      const translationResult = await this.translationService.translateCqlToElmAsync(
        currentCqlContent,
        this.libraryTranslationContextBuilder.fromLibraryResource(activeLibrary)
      );

      // Update translation state with errors/warnings
      this.ideStateService.setTranslationErrors(translationResult.errors);
      this.ideStateService.setTranslationWarnings(translationResult.warnings);
      this.ideStateService.setTranslationMessages(translationResult.messages);

      // Set ELM results in state (for display in ELM tab)
      this.ideStateService.setElmTranslationResults(translationResult.elmXml);

      // Check if we have ELM XML (even if there are errors, we may have partial results)
      if (!translationResult.elmXml) {
        console.warn('Translation failed - no ELM XML generated, executing without ELM');
        this.ideStateService.setExecutionStatus('Executing (translation failed, no ELM)...');
      } else {
        this.ideStateService.setExecutionStatus('Executing library...');
      }

      // Execute single library using CQL execution service
      // Pass the entire activeLibrary resource with current CQL content and ELM
      const result = await firstValueFrom(
        this.cqlExecutionService.executeLibrary(
          activeLibrary.id,
          subjects,
          {
            cqlContent: currentCqlContent,
            elmXml: translationResult.elmXml || undefined,
            libraryResource: activeLibrary,
            expressions
          }
        )
      );
      this.ideStateService.setExecutionStatus('');
      this.formatAndAddExecutionResults(
        result,
        `Library: ${activeLibrary.name || activeLibrary.id}`,
        subjects
      );
    } catch (error) {
      console.error('Library execution failed:', error);
      this.ideStateService.setExecutionStatus('');
      this.addErrorToOutput(`Library: ${activeLibrary.name || activeLibrary.id}`, error);
    } finally {
      this.ideStateService.setExecuting(false);
    }
  }

  async onReloadLibrary(): Promise<void> {
    const activeLibraryId = this.ideStateService.activeLibraryId();
    if (!activeLibraryId) {
      console.warn('No active library to reload');
      return;
    }

    this.ideStateService.setExecutionStatus('Reloading library...');

    try {
      const library: any = await firstValueFrom(this.libraryService.get(activeLibraryId));
      const libraryResource = this.ideStateService.getActiveLibraryResource();
      if (!libraryResource) {
        console.error('No active library resource found for reload');
        this.ideStateService.setExecutionStatus('');
        return;
      }

      const cqlAttachment = library.content?.find((c: any) => c.contentType === 'text/cql');
      const fromUrl = !!(cqlAttachment?.url && !cqlAttachment?.data);
      if (fromUrl) {
        this.ideStateService.updateLibraryResource(activeLibraryId, {
          contentLoading: true,
          contentLoadError: undefined
        });
      }

      try {
        const { cqlContent } = await firstValueFrom(this.libraryService.getCqlContent(library));
        this.ideStateService.updateLibraryResource(activeLibraryId, {
          cqlContent,
          originalContent: cqlContent,
          isDirty: false,
          library,
          contentLoading: false,
          contentLoadError: undefined
        });
        this.invalidateLibrarySourceCache(library, cqlContent);
        this.ideStateService.triggerReload(activeLibraryId);
        const libraryName = libraryResource.name || libraryResource.id || 'Library';
        this.ideStateService.addTextOutput(
          `Library Reloaded: ${libraryName}`,
          `Successfully reloaded library "${libraryName}" from server.\n\nContent length: ${cqlContent.length} characters`,
          'success'
        );
        this.ideStateService.setExecutionStatus('Library reloaded successfully');
        this.clearExecutionStatusAfter(2000);
      } catch (err: any) {
        const libraryName = libraryResource.name || libraryResource.id || 'Library';
        const message = err?.message ?? String(err);
        const errorMessage = `Could not load CQL from URL for library "${libraryName}". ${message}`;
        this.ideStateService.updateLibraryResource(activeLibraryId, {
          contentLoading: false,
          contentLoadError: errorMessage
        });
        this.ideStateService.addTextOutput(
          `Library Reload Failed: ${libraryName}`,
          errorMessage,
          'error'
        );
        this.ideStateService.setExecutionStatus('Failed to reload library');
        this.clearExecutionStatusAfter(3000);
      }
    } catch (error) {
      console.error('Failed to reload library:', error);
      this.ideStateService.setExecutionStatus('Failed to reload library');
      const libraryName = this.ideStateService.getActiveLibraryResource()?.name ||
        this.ideStateService.getActiveLibraryResource()?.id || 'Library';
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.ideStateService.addTextOutput(
        `Library Reload Failed: ${libraryName}`,
        `Failed to reload library "${libraryName}" from server.\n\nError: ${errorMessage}`,
        'error'
      );
      this.clearExecutionStatusAfter(3000);
    }
  }

  onFormatCql(): void {
    // Formatting is handled by the CqlEditorComponent
    // This method is called when the format button is clicked in the IDE toolbar
  }

  async onValidateCql(): Promise<void> {
    const editor = this.activeCqlEditor();
    if (!editor) {
      this.toastService.showWarning('Open a library to validate.', 'Validate CQL');
      return;
    }
    const cql = editor.getValue();
    if (!cql?.trim()) {
      this.toastService.showWarning('No CQL content to validate.', 'Validate CQL');
      return;
    }
    const activeLibrary = this.ideStateService.getActiveLibraryResource();
    const lines = cql.split('\n');
    const doc = {
      line: (lineNumber: number) => {
        let from = 0;
        for (let i = 0; i < lineNumber - 1; i++) {
          from += (lines[i]?.length ?? 0) + 1;
        }
        const text = lines[lineNumber - 1] ?? '';
        return { from, to: from + text.length, length: text.length };
      },
      lineAt: (pos: number) => {
        let offset = 0;
        for (let i = 0; i < lines.length; i++) {
          const lineLength = lines[i]?.length ?? 0;
          const lineEnd = offset + lineLength;
          if (pos <= lineEnd || i === lines.length - 1) {
            return { number: i + 1, from: offset };
          }
          offset = lineEnd + 1;
        }
        return { number: 1, from: 0 };
      }
    };
    const charDiagnostics = scanInvalidCqlCharacters(cql, doc);
    const full = await this.cqlValidationService.runFullValidationAsync(
      cql,
      undefined,
      this.libraryTranslationContextBuilder.fromLibraryResource(activeLibrary)
    );
    const structuredErrors = full.structuredErrors;
    const structuredWarnings = full.structuredWarnings;
    const syntaxErrors = [
      ...this.cqlValidationService.formatProblemsPanelMessages(full),
      ...formatCharacterDiagnosticsForProblems(charDiagnostics, doc)
    ];
    this.ideStateService.updateEditorState({
      syntaxErrors,
      isValidSyntax: problemsIndicateValidSyntax(syntaxErrors)
    });
    const libraryName = activeLibrary?.name ?? activeLibrary?.id ?? 'Library';
    this.ideStateService.addCqlValidationOutput(
      libraryName,
      { errors: structuredErrors, warnings: structuredWarnings },
      structuredErrors.length
    );
    if (structuredErrors.length === 0 && structuredWarnings.length === 0 && charDiagnostics.length === 0) {
      this.toastService.showSuccess('CQL validation passed with no errors or warnings.', 'Validate CQL');
    } else if (structuredErrors.length === 0) {
      this.toastService.showWarning(
        `CQL validation completed with ${structuredWarnings.length + charDiagnostics.length} warning(s).`,
        'Validate CQL'
      );
    } else {
      this.toastService.showError(
        `CQL validation found ${structuredErrors.length} error(s).`,
        'Validate CQL'
      );
    }
  }

  // Library save helper methods
  private async updateExistingLibrary(library: any, cqlContent: string, elmXml: string): Promise<void> {
    // Get the current library resource to get the latest metadata
    const activeLibrary = this.ideStateService.getActiveLibraryResource();
    
    // Update the library's CQL content and metadata
    const updatedLibrary = {
      ...library,
      id: activeLibrary?.id || library.id, // Use the current ID (which might have changed)
      name: activeLibrary?.name || library.name,
      title: activeLibrary?.title || library.title,
      version: activeLibrary?.version || library.version || '1.0.0',
      description: activeLibrary?.description || library.description,
      url: activeLibrary?.url || library.url || this.libraryService.urlFor(activeLibrary?.id || library.id),
      content: [
        {
          contentType: 'text/cql',
          data: encodeUtf8Base64(cqlContent)
        },
        {
          contentType: 'application/elm+xml',
          data: encodeUtf8Base64(elmXml)
        }
      ]
    };

    try {
      const savedLibrary = await firstValueFrom(this.libraryService.put(updatedLibrary));
      this.ideStateService.setExecutionStatus('Library saved successfully');

      // Update the library resource with the saved library
      // Preserve user's URL choice (including empty) - do not overwrite with generated URL
      const currentId = this.ideStateService.activeLibraryId()!;

      this.ideStateService.updateLibraryResource(currentId, {
        library: savedLibrary,
        originalContent: cqlContent,
        isDirty: false
      });
      this.invalidateLibrarySourceCache(savedLibrary, cqlContent);

      // Add success message to Console pane
      const libraryName = activeLibrary?.name || activeLibrary?.id || 'Library';
      this.ideStateService.addTextOutput(
        `Library Saved: ${libraryName} - Server caches may be updated asynchronously`,
        `Successfully saved library "${libraryName}". Server caches may updated asynchronously.\n\nLibrary ID: ${currentId}\nContent length: ${cqlContent.length} characters`,
        'success'
      );

      // Clear status after a short delay
      this.clearExecutionStatusAfter(2000);
    } catch (error) {
      console.error('Failed to update library:', error);
      this.ideStateService.setExecutionStatus('Failed to save library');

      // Add error message to Console pane
      const libraryName = activeLibrary?.name || activeLibrary?.id || 'Library';
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.ideStateService.addTextOutput(
        `Save Failed: ${libraryName}`,
        `Failed to save library "${libraryName}" to server.\n\nError: ${errorMessage}`,
        'error'
      );

      // Mark as dirty again since save failed
      this.ideStateService.updateLibraryResource(this.ideStateService.activeLibraryId()!, {
        isDirty: true
      });

      // Clear error status after a short delay
      this.clearExecutionStatusAfter(3000);
    }
  }

  private async createNewLibrary(libraryResource: any, cqlContent: string, elmXml: string): Promise<void> {
    // Create a new FHIR Library resource with our id so PUT creates it with that id
    const newLibrary: Library = {
      resourceType: 'Library' as const,
      id: libraryResource.id,
      name: libraryResource.name || libraryResource.id,
      title: libraryResource.title || libraryResource.name || libraryResource.id,
      version: libraryResource.version || '1.0.0',
      status: 'active' as const,
      url: libraryResource.url || this.libraryService.urlFor(libraryResource.id),
      type: {
        coding: [
          {
            system: 'http://terminology.hl7.org/CodeSystem/library-type',
            code: 'logic-library',
            display: 'Logic Library'
          }
        ]
      },
      content: [
        {
          contentType: 'text/cql',
          data: encodeUtf8Base64(cqlContent)
        },
        {
          contentType: 'application/elm+xml',
          data: encodeUtf8Base64(elmXml)
        }
      ],
      description: libraryResource.description || `Library ${libraryResource.name || libraryResource.id}`
    };

    try {
      const savedLibrary = await firstValueFrom(this.libraryService.put(newLibrary));
      this.ideStateService.setExecutionStatus('Library saved successfully');

      this.ideStateService.updateLibraryResource(libraryResource.id, {
        library: savedLibrary,
        originalContent: cqlContent,
        isDirty: false
      });
      this.invalidateLibrarySourceCache(savedLibrary, cqlContent);

      const libraryName = libraryResource.name || libraryResource.id || 'Library';
      this.ideStateService.addTextOutput(
        `Library Created: ${libraryName}`,
        `Successfully created and saved library "${libraryName}" to server.\n\nLibrary ID: ${libraryResource.id}\nContent length: ${cqlContent.length} characters`,
        'success'
      );

      this.clearExecutionStatusAfter(2000);
    } catch (error) {
      console.error('Failed to create library:', error);
      this.ideStateService.setExecutionStatus('Failed to save library');

      const libraryName = libraryResource.name || libraryResource.id || 'Library';
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.ideStateService.addTextOutput(
        `Save Failed: ${libraryName}`,
        `Failed to create library "${libraryName}" on server.\n\nError: ${errorMessage}`,
        'error'
      );

      this.ideStateService.updateLibraryResource(libraryResource.id, {
        isDirty: true
      });

      this.clearExecutionStatusAfter(3000);
    }
  }

  private formatAndAddExecutionResults(results: unknown, title: string, subjects: IdeExecutionSubject[] = []): void {
    const normalizedResults = normalizeExecutionResults(results);

    if (shouldRenderExecutionResultsSeparately(normalizedResults, subjects)) {
      const sections = buildSeparateExecutionOutputSections(
        normalizedResults,
        title,
        subjects,
        this.ideContextService.getSubjectDisplayById(),
        index => `output_${index}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
      );
      this.ideStateService.addOutputSections(sections);
      this.ideStateService.activateOutputTab();
      return;
    }

    // No patient context: keep existing behavior (one combined json section).
    const content = this.formatExecutionResults(normalizedResults);
    const status = normalizedResults.some(r => r.error) ? 'error' : 'success';
    const executionTime = normalizedResults.reduce((total, r) => total + (r.executionTime || 0), 0);

    this.ideStateService.addOutputSection({
      id: `output_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
      title,
      content,
      type: 'json',
      status,
      executionTime,
      expanded: true,
      timestamp: new Date()
    });
    this.ideStateService.activateOutputTab();
  }

  private addErrorToOutput(title: string, error: any): void {
    const content = `Execution failed:\n${JSON.stringify(error)}`;
    
    this.ideStateService.addOutputSection({
      id: `output_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      title: title,
      content: content,
      type: 'error',
      status: 'error',
      executionTime: 0,
      expanded: false,
      timestamp: new Date()
    });
    this.ideStateService.activateOutputTab();
  }

  private formatExecutionResults(results: any[]): string {
    if (results.length === 0) return JSON.stringify([], null, 2);

    // Emit valid JSON so the Console can pretty-print + Prism-highlight it correctly.
    const payload = results.map(r => ({
      executionTime: r.executionTime,
      functionName: r.functionName,
      error: r.error ?? undefined,
      result: r.result ?? undefined
    }));

    return JSON.stringify(payload);
  }

  // Keyboard shortcuts for the welcome message
  getAllShortcuts() {
    return buildAllShortcuts(detectMacPlatform());
  }

  // Keyboard shortcut handler
  handleKeyboardShortcuts(event: KeyboardEvent): void {

    // Prevent default behavior for our shortcuts
    const isMac = detectMacPlatform();
    const isCmdKey = isMac ? event.metaKey : event.ctrlKey;
    
    // F4 - Save Active Editor
    if (event.key === 'F4') {
      event.preventDefault();
      this.onSaveLibrary();
      return;
    }

    // F5 - Execute Active Library
    if (event.key === 'F5' && !isCmdKey) {
      event.preventDefault();
      this.onExecuteLibrary();
      return;
    }

    // F6 - Execute All Libraries
    if (event.key === 'F6') {
      event.preventDefault();
      this.onExecuteAll();
      return;
    }
    
    // Cmd+Option+W (Mac) or Ctrl+W (PC) - Close Active Editor
    if (isMac) {
      // Mac: Cmd+Option+W - check for the key that produces ∑ in Dvorak (Comma key)
      if (event.metaKey && event.altKey && event.code === 'Comma') {
        event.preventDefault();
        this.onCloseActiveEditor();
        return;
      }
    } else {
      // PC: Ctrl+W - use physical key position (KeyW) regardless of layout
      if (event.code === 'KeyW' && event.ctrlKey) {
        event.preventDefault();
        this.onCloseActiveEditor();
        return;
      }
    }
  }

  // Close active editor method
  private onCloseActiveEditor(): void {
    const activeLibraryId = this.ideStateService.activeLibraryId();
    if (activeLibraryId) {
      this.onDeleteLibrary(activeLibraryId);
    }
  }

  private clearExecutionStatusAfter(delayMs: number): void {
    const deadline = performance.now() + delayMs;
    const tick = (): void => {
      if (performance.now() >= deadline) {
        this.ideStateService.setExecutionStatus('');
      } else {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
  }

  private invalidateLibrarySourceCache(
    library: { name?: string; version?: string | null } | null | undefined,
    cqlContent?: string | null
  ): void {
    if (library?.name) {
      this.translationService.invalidateIncludedLibraryCache(
        library.name,
        library.version ?? null,
        null,
        cqlContent
      );
    }
  }

}
