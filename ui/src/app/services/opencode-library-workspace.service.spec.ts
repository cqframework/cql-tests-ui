// Author: Preston Lee

import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { of, Subject, throwError } from 'rxjs';
import type { Library } from 'fhir/r4';
import type { LibraryResource } from '../components/cql-ide/shared/ide-types';
import { IdeStateService } from './ide-state.service';
import { LibraryService } from './library.service';
import { OpenCodeLibraryWorkspaceService } from './opencode-library-workspace.service';
import { decodeUtf8Base64 } from './utf8-encoding.lib';

const member = (id: string): LibraryResource => ({ id, name: id, description: '', library: null,
  cqlContent: `library ${id}`, originalContent: `library ${id}`, isDirty: false, isActive: false });

describe('OpenCode library persistence', () => {
  let service: OpenCodeLibraryWorkspaceService;
  let ide: IdeStateService;
  const put = vi.fn((library: Library) => of(library));

  beforeEach(() => {
    TestBed.resetTestingModule();
    put.mockReset().mockImplementation((library: Library) => of(library));
    TestBed.configureTestingModule({ providers: [{ provide: LibraryService, useValue: {
      put, urlFor: (id: string) => `http://fhir.test/Library/${id}`,
    } }] });
    service = TestBed.inject(OpenCodeLibraryWorkspaceService);
    ide = TestBed.inject(IdeStateService);
  });

  it('retains a library when its tab closes and reopens the same identity', async () => {
    const library = member('Main');
    ide.addLibraryResource(library);
    service.remember([library]);
    ide.removeLibraryResource(library.id);
    expect(await service.open(library.id)).toBe(library);
    expect(ide.libraryResources().map(item => item.id)).toContain('Main');
  });

  it('persists a new CQL Library before exposing it to the IDE', async () => {
    const pending = new Subject<Library>();
    put.mockReturnValue(pending);
    const operation = { kind: 'create' as const, libraryId: 'new-id', name: 'Shared', file: 'libraries/Shared.cql', content: 'library Shared' };
    const save = service.applyOperation(operation);
    expect(ide.libraryResources()).toHaveLength(0);
    const payload = put.mock.calls[0][0];
    expect(payload.resourceType).toBe('Library');
    expect(payload.id).toBe('new-id');
    expect(decodeUtf8Base64(payload.content![0].data!)).toBe(operation.content);
    pending.next(payload); pending.complete();
    await save;
    expect(ide.libraryResources()[0]).toMatchObject({ id: 'new-id', name: 'Shared', isDirty: false, originalContent: 'library Shared' });
  });

  it('keeps rename identity and removes stale ELM while saving the new name and content', async () => {
    const library = { ...member('same-id'), library: { resourceType: 'Library' as const, id: 'same-id', status: 'active' as const, type: {},
      content: [{ contentType: 'application/elm+json', data: 'old-elm' }] } };
    ide.addLibraryResource(library);
    await service.applyOperation({ kind: 'rename', libraryId: library.id, name: 'Renamed', file: 'libraries/Renamed.cql', previousFile: 'libraries/Old.cql', content: 'library Renamed' });
    expect(put.mock.calls[0][0]).toMatchObject({ id: 'same-id', name: 'Renamed' });
    expect(put.mock.calls[0][0].content).toHaveLength(1);
    expect(ide.libraryResources()[0]).toMatchObject({ id: 'same-id', name: 'Renamed' });
  });

  it('does not expose a new file when its FHIR save fails', async () => {
    put.mockReturnValue(throwError(() => new Error('FHIR unavailable')));
    await expect(service.applyOperation({ kind: 'create', libraryId: 'new-id', name: 'Shared', file: 'libraries/Shared.cql', content: 'library Shared' })).rejects.toThrow('FHIR unavailable');
    expect(ide.libraryResources()).toHaveLength(0);
  });

  it('pins saves to the chosen file and preserves edits made during the request', async () => {
    const a = member('A'); const b = member('B');
    ide.addLibraryResource(a); ide.addLibraryResource(b);
    ide.selectLibraryResource('A');
    const pending = new Subject<Library>(); put.mockReturnValue(pending);
    const saving = service.save(a, 'library A\ndefine Value: 1');
    ide.selectLibraryResource('B');
    ide.updateLibraryResource('A', { cqlContent: 'library A\ndefine Value: 2', isDirty: true });
    pending.next(put.mock.calls[0][0]); pending.complete();
    await saving;
    expect(put.mock.calls[0][0].id).toBe('A');
    expect(ide.libraryResources().find(item => item.id === 'A')).toMatchObject({ cqlContent: 'library A\ndefine Value: 2', originalContent: 'library A\ndefine Value: 1', isDirty: true });
    expect(ide.libraryResources().find(item => item.id === 'B')).toEqual(b);
  });
});
