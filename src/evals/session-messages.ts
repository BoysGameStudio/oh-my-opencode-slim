export function isTerminalSession(
  messages: Array<{
    info?: { role?: string; finish?: string };
    parts?: Array<{
      type?: string;
      state?: { status?: string };
      text?: string;
    }>;
  }>,
): boolean {
  const last = messages[messages.length - 1];
  if (last?.info?.role !== 'assistant') return false;
  const finish = last.info.finish;
  if (!finish || finish === 'tool-calls' || finish === 'unknown') return false;
  const pendingTool = (last.parts ?? []).some(
    (p) =>
      p.type === 'tool' &&
      (p.state?.status === 'pending' || p.state?.status === 'running'),
  );
  return !pendingTool;
}

export function assistantText(
  messages: Array<{
    info?: { role?: string };
    parts?: Array<{ type?: string; text?: string }>;
  }>,
): string {
  return messages
    .filter((m) => m.info?.role === 'assistant')
    .map((m) =>
      (m.parts ?? [])
        .filter((p) => p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text as string)
        .join(''),
    )
    .join('')
    .trim();
}
