// Author: Preston Lee

import pino, { type Logger } from 'pino';

export let openCodeLogger: Logger = pino({ level: 'silent' });

export function configureOpenCodeLogger(parent: Logger): Logger {
  openCodeLogger = parent.child({ component: 'opencode' });
  return openCodeLogger;
}
