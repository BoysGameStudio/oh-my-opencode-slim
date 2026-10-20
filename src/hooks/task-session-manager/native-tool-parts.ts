import { isRecord as isObjectRecord } from '../../utils/guards';

/** Read a v2 delegation tool name without normalizing the part. */
export function nativeDelegationToolName(
  part: Record<string, unknown>,
): string | undefined {
  const name = part.toolName ?? part.name;
  return typeof name === 'string' ? name : undefined;
}

export function nativeToolCallID(
  part: Record<string, unknown>,
): string | undefined {
  const callID = part.toolCallId ?? part.id;
  return typeof callID === 'string' && callID !== '' ? callID : undefined;
}

/** Read a v2 tool-result payload without normalizing or rewriting it. */
export function nativeToolResultText(
  part: Record<string, unknown>,
): string | undefined {
  const value = part.output ?? part.result;
  if (typeof value === 'string') return value;
  if (!isObjectRecord(value)) return undefined;
  if (typeof value.value === 'string') return value.value;
  if (typeof value.text === 'string') return value.text;
  if (Array.isArray(value.value)) return textEntries(value.value);
  if (Array.isArray(value.content)) return textEntries(value.content);
  return undefined;
}

function textEntries(entries: unknown[]): string | undefined {
  const text = entries
    .filter(isObjectRecord)
    .filter((entry) => entry.type === 'text' && typeof entry.text === 'string')
    .map((entry) => entry.text as string)
    .join('');
  return text === '' ? undefined : text;
}
