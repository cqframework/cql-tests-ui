// Author: Preston Lee

const INTERNAL_CONTEXT = /<cql-studio-(?:editor|problems|resume)-context/;

/**
 * Reduce persisted SDK messages to a bounded user/assistant text history before
 * crossing back into the runner. Tool payloads and internal context are dropped.
 */
export function openCodeResumeMessages(messages: unknown[], maxCharacters = 500_000): unknown[] {
  const result: unknown[] = [];
  let remaining = maxCharacters;
  const candidates = messages.slice(-200);
  for (let index = candidates.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const raw = candidates[index];
    if (!raw || typeof raw !== 'object') continue;
    const message = raw as { info?: { id?: unknown; role?: unknown }; parts?: unknown[] };
    const role = message.info?.role === 'assistant' ? 'assistant'
      : message.info?.role === 'user' ? 'user' : null;
    if (!role || !Array.isArray(message.parts)) continue;
    const text = message.parts
      .filter((part): part is { type: string; text: string } => Boolean(
        part && typeof part === 'object'
        && (part as { type?: unknown }).type === 'text'
        && typeof (part as { text?: unknown }).text === 'string'
      ))
      .map(part => part.text)
      .filter(value => !INTERNAL_CONTEXT.test(value))
      .join('\n')
      .trim();
    if (!text) continue;
    const retained = text.slice(Math.max(0, text.length - remaining));
    remaining -= retained.length;
    const id = typeof message.info?.id === 'string' ? message.info.id : `resumed-message-${index}`;
    result.unshift({
      info: { id, role },
      parts: [{ id: `${id}-text`, messageID: id, type: 'text', text: retained }],
    });
  }
  return result;
}

export function openCodeResumeTranscript(messages: unknown[], maxCharacters = 80_000): string {
  const turns: string[] = [];
  for (const raw of openCodeResumeMessages(messages, maxCharacters)) {
    const message = raw as { info: { role: 'user' | 'assistant' }; parts: Array<{ text: string }> };
    turns.push(`${message.info.role === 'assistant' ? 'Assistant' : 'User'}: ${message.parts[0].text}`);
  }
  const header = 'This is the saved conversation from this CQL Studio session. Continue it using the current workspace files as authoritative:';
  const available = Math.max(0, maxCharacters - header.length - 2);
  const body = turns.join('\n\n');
  return `${header}\n\n${body.slice(Math.max(0, body.length - available))}`;
}
