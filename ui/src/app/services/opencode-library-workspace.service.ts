// Author: Preston Lee

import { Injectable, inject } from '@angular/core';
import type { Library } from 'fhir/r4';
import { firstValueFrom } from 'rxjs';
import type { OpenCodeFileOperation } from '@cql-studio/core';
import type { LibraryResource } from '../components/cql-ide/shared/ide-types';
import { IdeStateService, TabDataScope } from './ide-state.service';
import { LibraryService } from './library.service';
import { convertCqlToFhirLibrary } from './cql-file-to-fhir-library.lib';
import { OpenCodeEnvironmentBindingService } from './opencode-environment-binding.service';
import { encodeUtf8Base64 } from './utf8-encoding.lib';

@Injectable({ providedIn: 'root' })
export class OpenCodeLibraryWorkspaceService {
  private readonly ide = inject(IdeStateService);
  private readonly libraries = inject(LibraryService);
  private readonly binding = inject(OpenCodeEnvironmentBindingService);
  private readonly members = new Map<string, LibraryResource>();

  private memberKey(id: string): string {
    const binding = this.binding.captureCurrent();
    return JSON.stringify([binding.key, binding.configurationFingerprint, id]);
  }

  remember(libraries: LibraryResource[]): void {
    for (const library of libraries) this.members.set(this.memberKey(library.id), library);
  }

  get(id: string): LibraryResource | undefined {
    return this.ide.libraryResources().find(library => library.id === id) ?? this.members.get(this.memberKey(id));
  }

  forget(id: string): void { this.members.delete(this.memberKey(id)); }

  async open(id: string): Promise<LibraryResource> {
    let library = this.get(id);
    if (!library) {
      const resource = await firstValueFrom(this.libraries.get(id));
      const source = await firstValueFrom(this.libraries.getCqlContent(resource));
      library = { id, name: resource.name ?? id, description: resource.description ?? '', library: resource,
        cqlContent: source.cqlContent, originalContent: source.cqlContent, isDirty: false, isActive: false,
        version: resource.version, url: resource.url };
    }
    this.ide.addLibraryResource(library);
    this.members.set(this.memberKey(id), library);
    return library;
  }

  async save(library: LibraryResource, content: string, elmXml?: string): Promise<LibraryResource> {
    if (library.isReadOnly) throw new Error(`Library ${library.name} is read-only`);
    const resource: Library = {
      ...(library.library ?? { resourceType: 'Library', status: 'draft', type: { coding: [
        { system: 'http://terminology.hl7.org/CodeSystem/library-type', code: 'logic-library' },
      ] } }),
      id: library.id, name: library.name, title: library.title ?? library.name,
      version: library.version, url: library.url ?? this.libraries.urlFor(library.id),
      content: [
        ...(library.library?.content ?? []).filter(item => !['text/cql', 'application/elm+xml', 'application/elm+json'].includes(item.contentType ?? '')),
        { contentType: 'text/cql', data: encodeUtf8Base64(content) },
        ...(elmXml ? [{ contentType: 'application/elm+xml', data: encodeUtf8Base64(elmXml) }] : []),
      ],
    };
    const saved = await firstValueFrom(this.libraries.put(resource));
    const current = this.get(library.id);
    const cqlContent = current && current.cqlContent !== library.cqlContent ? current.cqlContent : content;
    const result = { ...library, library: saved, cqlContent, originalContent: content, isDirty: cqlContent !== content };
    this.ide.addLibraryResource(result);
    this.members.set(this.memberKey(library.id), result);
    this.ide.invalidateTabData(TabDataScope.LibraryList);
    return result;
  }

  async applyOperation(operation: OpenCodeFileOperation): Promise<void> {
    const metadata = convertCqlToFhirLibrary(operation.content, operation.name + '.cql', '');
    if (metadata.name !== operation.name) throw new Error('The CQL library declaration must match the requested filename');
    const existing = operation.kind === 'rename' ? await this.open(operation.libraryId) : undefined;
    const library: LibraryResource = existing
      ? { ...existing, name: operation.name, title: operation.name, version: metadata.version }
      : { id: operation.libraryId, name: operation.name, description: metadata.description ?? '', version: metadata.version, library: null,
          cqlContent: operation.content, originalContent: '', isDirty: true, isActive: false };
    await this.save(library, operation.content);
    this.ide.selectLibraryResource(library.id);
    this.ide.triggerReload(library.id);
  }
}
