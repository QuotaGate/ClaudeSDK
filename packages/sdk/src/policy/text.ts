import { isRecord } from '../internal/util.js';

/** A piece of text the policy rules scan, tagged with where it came from. */
export interface TextSegment {
  source: 'user' | 'assistant' | 'tool_result';
  text: string;
}

/** Extracts text from `messages[].content` (strings, text blocks, tool_result blocks). */
export function messageSegments(messages: unknown): TextSegment[] {
  const out: TextSegment[] = [];
  if (!Array.isArray(messages)) return out;
  for (const msg of messages) {
    if (!isRecord(msg)) continue;
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    collect(msg.content, role, out);
  }
  return out;
}

function collect(content: unknown, source: TextSegment['source'], out: TextSegment[]): void {
  if (typeof content === 'string') {
    out.push({ source, text: content });
    return;
  }
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (typeof block === 'string') {
      out.push({ source, text: block });
    } else if (isRecord(block)) {
      if (block.type === 'text' && typeof block.text === 'string') {
        out.push({ source, text: block.text });
      } else if (block.type === 'tool_result') {
        collect(block.content, 'tool_result', out);
      }
    }
  }
}

/** System prompt as plain text (string or array of text blocks). */
export function systemText(system: unknown): string | null {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    const parts = system
      .filter(isRecord)
      .map((b) => (typeof b.text === 'string' ? b.text : ''))
      .filter(Boolean);
    return parts.length ? parts.join('\n') : null;
  }
  return null;
}

/**
 * Rough input-token estimate (~4 characters per token) over system, messages and tools.
 * Used only for pre-flight budget checks; actual usage is recorded from the response.
 */
export function estimateInputTokens(params: Record<string, unknown>): number {
  let chars = 0;
  const sys = systemText(params.system);
  if (sys) chars += sys.length;
  for (const seg of messageSegments(params.messages)) chars += seg.text.length;
  if (Array.isArray(params.tools)) {
    try {
      chars += JSON.stringify(params.tools).length;
    } catch {
      // ignore unserializable tools
    }
  }
  return Math.ceil(chars / 4);
}
