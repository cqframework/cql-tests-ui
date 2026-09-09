// Author: Preston Lee

import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenCodeSession, OpenCodeFileDiff, OpenCodePermissionRequest } from '../../../../models/opencode.model';
import { AiTabComponent } from './ai-tab.component';
import { IdeStateService } from '../../../../services/ide-state.service';
import { OpenCodeService } from '../../../../services/opencode.service';
import { OpenCodeEditorBridgeService } from '../../../../services/opencode-editor-bridge.service';
import { OpenCodeLibraryWorkspaceService } from '../../../../services/opencode-library-workspace.service';
import { OpenCodeVsacImportService } from '../../../../services/opencode-vsac-import.service';
import { SettingsService } from '../../../../services/settings.service';
import { LibraryService } from '../../../../services/library.service';

const session: OpenCodeSession = { id: 'session', openCodeSessionId: 'sdk', title: 'Main', status: 'idle',
  activeLibraryId: 'A', activeFile: 'libraries/A.cql', createdAt: '', updatedAt: '', lastActivityAt: '', expiresAt: '', model: 'ollama/test', reasoningEnabled: false };
const diffs: OpenCodeFileDiff[] = ['A', 'B', 'C'].map(id => ({ file: `libraries/${id}.cql`, libraryId: id, before: `library ${id}`, after: `library ${id}\ndefine Value: 1`, additions: 1, deletions: 0 }));

describe('OpenCode multifile review and approvals', () => {
  let component: AiTabComponent;
  let ide: IdeStateService;
  let bridge: OpenCodeEditorBridgeService;
  const api = { syncActiveFile: vi.fn(), respondToPermission: vi.fn(), isSessionEnvironmentCurrent: () => true,
    findFiles: vi.fn(), addLibraries: vi.fn(), validate: vi.fn(), getDiff: vi.fn() };
  const workspace = { remember: vi.fn(), get: vi.fn(), applyOperation: vi.fn() };

  beforeEach(() => {
    TestBed.resetTestingModule();
    vi.clearAllMocks();
    api.syncActiveFile.mockResolvedValue(undefined);
    api.respondToPermission.mockResolvedValue(undefined);
    api.findFiles.mockResolvedValue(diffs.map(diff => ({ path: diff.file, libraryId: diff.libraryId, name: diff.file, writable: true })));
    api.validate.mockResolvedValue({ valid: true, diagnostics: [], checkedAt: '' });
    workspace.applyOperation.mockResolvedValue(undefined);
    TestBed.configureTestingModule({ providers: [
      { provide: OpenCodeService, useValue: api },
      { provide: SettingsService, useValue: {} },
      { provide: OpenCodeLibraryWorkspaceService, useValue: workspace },
      { provide: LibraryService, useValue: { deletedLibraryIds: signal(new Set()) } },
      { provide: OpenCodeVsacImportService, useValue: {} },
    ] });
    ide = TestBed.inject(IdeStateService);
    bridge = TestBed.inject(OpenCodeEditorBridgeService);
    for (const diff of diffs) {
      ide.addLibraryResource({ id: diff.libraryId, name: diff.libraryId, description: '', cqlContent: diff.before,
        originalContent: diff.before, library: null, isActive: false, isDirty: false });
      bridge.recordDocument(diff.libraryId, diff.before, 0);
    }
    ide.selectLibraryResource('A');
    workspace.get.mockImplementation((id: string) => ide.libraryResources().find(library => library.id === id));
    component = TestBed.runInInjectionContext(() => new AiTabComponent());
    component.session.set(session);
    component.workspaceFiles.set(diffs.map(diff => ({ path: diff.file, libraryId: diff.libraryId, name: diff.file, writable: true })));
  });

  it('follows a live edit to another file using its revision, even when the active document differs', () => {
    const apply = vi.spyOn(component.applyLibraryChange, 'emit');
    bridge.recordDocument('A', 'library A', 7);
    component.liveEditsEnabled.set(true);
    component['handleWorkspaceChange']({ libraryId: 'B', file: 'libraries/B.cql', content: diffs[1].after, baseRevision: 0 });
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ libraryId: 'B', cqlContent: diffs[1].after, mode: 'live' }));
    expect(component.workingFile()).toBe('libraries/B.cql');
    expect(component.liveEditsEnabled()).toBe(true);
  });

  it('pauses live edits only when the edited file has a newer user revision', () => {
    const apply = vi.spyOn(component.applyLibraryChange, 'emit');
    component.liveEditsEnabled.set(true);
    bridge.recordDocument('B', 'user edit', 1);
    component['handleWorkspaceChange']({ libraryId: 'B', file: 'libraries/B.cql', content: diffs[1].after, baseRevision: 0 });
    expect(apply).not.toHaveBeenCalled();
    expect(component.liveEditsEnabled()).toBe(false);
  });

  it('discards only the chosen file using that file’s current content', async () => {
    component.diffs.set(diffs);
    await component.discardChange(diffs[2]);
    expect(api.syncActiveFile).toHaveBeenCalledWith('session', 'library C', 0, 'C');
    expect(component.diffs().map(diff => diff.libraryId)).toEqual(['A', 'B']);
  });

  it('saves one accepted file while leaving the other decisions pending', async () => {
    component.diffs.set(diffs);
    vi.spyOn(component.applyLibraryChange, 'emit').mockImplementation(change => change.onSaveComplete?.(true));
    await component.applyAndSave(diffs[1]);
    expect(api.validate).toHaveBeenCalledWith('session', 'libraries/B.cql');
    expect(api.syncActiveFile).toHaveBeenCalledWith('session', diffs[1].after, 0, 'B');
    expect(component.diffs().map(diff => diff.libraryId)).toEqual(['A', 'C']);
  });

  it('auto-accepts creation in live mode after saving, but always asks for renames', async () => {
    const permission = (kind: 'create' | 'rename'): OpenCodePermissionRequest => ({ id: kind, type: `cql.${kind}`, title: kind,
      metadata: { operation: { kind, libraryId: 'new', name: 'New', content: 'library New', file: 'libraries/New.cql' } } });
    component.liveEditsEnabled.set(true);
    component['handleEvent']({ type: 'permission.asked', properties: permission('create') as unknown as Record<string, unknown> });
    await Promise.resolve(); await Promise.resolve();
    expect(workspace.applyOperation).toHaveBeenCalledTimes(1);
    expect(api.respondToPermission).toHaveBeenCalledWith('session', 'create', 'once');
    component['handleEvent']({ type: 'permission.asked', properties: permission('rename') as unknown as Record<string, unknown> });
    expect(workspace.applyOperation).toHaveBeenCalledTimes(1);
    expect(component.permissions().some(item => item.id === 'rename')).toBe(true);
  });

  it('keeps a failed library save pending and does not acknowledge the tool', async () => {
    workspace.applyOperation.mockRejectedValueOnce(new Error('Save failed'));
    await component.respondToPermission({ id: 'create', type: 'cql.create', title: 'Create', metadata: { operation: { kind: 'create' } } }, 'once');
    expect(api.respondToPermission).not.toHaveBeenCalled();
    expect(component.error()).toBe('Save failed');
  });
});
