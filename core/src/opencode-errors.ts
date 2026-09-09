// Author: Preston Lee

import type { OpenCodeErrorBody } from './opencode.js';

export class OpenCodeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 500,
    readonly retryable = false,
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'OpenCodeError';
  }

  toBody(): OpenCodeErrorBody {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function normalizeOpenCodeError(error: unknown): OpenCodeError {
  if (error instanceof OpenCodeError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes('not found') || lower.includes('does not exist')) {
    return new OpenCodeError('SESSION_NOT_FOUND', message, 404, false);
  }
  if (lower.includes('timed out') || lower.includes('timeout') || lower.includes('abort')) {
    return new OpenCodeError('UPSTREAM_TIMEOUT', message, 504, true);
  }
  if (lower.includes('model') && (lower.includes('not found') || lower.includes('pull'))) {
    return new OpenCodeError('OLLAMA_MODEL_NOT_FOUND', message, 502, false);
  }
  if (lower.includes('context') && (lower.includes('length') || lower.includes('window'))) {
    return new OpenCodeError('OLLAMA_CONTEXT_LIMIT', message, 422, false);
  }
  if (lower.includes('fetch failed') || lower.includes('econnrefused') || lower.includes('unavailable')) {
    return new OpenCodeError('UPSTREAM_UNAVAILABLE', message, 503, true);
  }
  return new OpenCodeError('OPENCODE_ERROR', message, 500, false);
}
