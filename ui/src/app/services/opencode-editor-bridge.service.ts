// Author: Preston Lee

import { Injectable, signal } from '@angular/core';
import { OpenCodeEditorContext } from '../models/opencode.model';

export interface OpenCodeEditorDocument {
  libraryId: string;
  content: string;
  userRevision: number;
}

export interface OpenCodeInlineEditOptions {
  prompt?: string;
  autoSend?: boolean;
}

@Injectable({ providedIn: 'root' })
export class OpenCodeEditorBridgeService {
  readonly document = signal<OpenCodeEditorDocument | null>(null);
  readonly documents = signal<ReadonlyMap<string, OpenCodeEditorDocument>>(new Map());
  readonly selection = signal<OpenCodeEditorContext | null>(null);
  readonly inlineRequest = signal<{
    id: number;
    context: OpenCodeEditorContext;
    prompt?: string;
    autoSend: boolean;
  } | null>(null);
  private inlineSequence = 0;

  recordDocument(libraryId: string, content: string, userRevision: number): void {
    this.documents.update(documents => new Map(documents).set(libraryId, { libraryId, content, userRevision }));
    this.document.set({ libraryId, content, userRevision });
    const selection = this.selection();
    if (selection && selection.libraryId === libraryId && selection.documentRevision !== userRevision) {
      this.selection.set(null);
    }
  }

  recordSelection(context: OpenCodeEditorContext | null): void {
    this.selection.set(context?.selectedText ? context : null);
  }

  requestInlineEdit(context: OpenCodeEditorContext, options: OpenCodeInlineEditOptions = {}): void {
    this.selection.set(context);
    this.inlineRequest.set({
      id: ++this.inlineSequence,
      context: { ...context, mode: 'inline' },
      prompt: options.prompt,
      autoSend: Boolean(options.autoSend),
    });
  }
}
