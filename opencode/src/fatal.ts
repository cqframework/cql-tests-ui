// Author: Preston Lee

export const OpenCodeExitCode = {
  GENERAL: 1,
  UNAVAILABLE: 69,
  SOFTWARE: 70,
  OSERR: 71,
  CONFIG: 78,
} as const;

export type OpenCodeExitCodeValue = (typeof OpenCodeExitCode)[keyof typeof OpenCodeExitCode];

export class OpenCodeFatalError extends Error {
  constructor(
    message: string,
    readonly exitCode: OpenCodeExitCodeValue = OpenCodeExitCode.GENERAL
  ) {
    super(message);
    this.name = 'OpenCodeFatalError';
  }
}

export function exitCodeForFatal(error: unknown): OpenCodeExitCodeValue {
  return error instanceof OpenCodeFatalError ? error.exitCode : OpenCodeExitCode.GENERAL;
}
