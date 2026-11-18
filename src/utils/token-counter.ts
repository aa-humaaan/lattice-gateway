import { countTokens } from 'gpt-tokenizer';
import type {
  CanonicalMessage,
  CanonicalContentPart,
} from '../core/types/canonical';

/**
 * Returns exact token count using real BPE tokenizer (gpt-tokenizer).
 * Safe against empty strings and malformed inputs with 4-char fallback.
 */
export function countTextTokens(text: string): number {
  if (!text) return 0;
  try {
    return countTokens(text);
  } catch {
    return Math.ceil(text.length / 4);
  }
}

/**
 * Counts token cost of an individual CanonicalContentPart.
 */
export function countPartTokens(part: unknown): number {
  if (!part || typeof part !== 'object') return 0;
  const p = part as Record<string, unknown>;

  switch (p.type) {
    case 'text':
      return typeof p.text === 'string' ? countTextTokens(p.text) : 0;
    case 'image':
      return 1000; // Standard vision tile baseline
    case 'thinking':
      return typeof p.thinking === 'string' ? countTextTokens(p.thinking) : 0;
    case 'redacted_thinking':
      return typeof p.data === 'string' ? countTextTokens(p.data) : 0;
    case 'tool_use': {
      const nameTokens = typeof p.name === 'string' ? countTextTokens(p.name) : 0;
      const inputStr =
        typeof p.input === 'string' ? p.input : JSON.stringify(p.input ?? {});
      const inputTokens = countTextTokens(inputStr);
      return nameTokens + inputTokens + 8; // Tool call structural formatting tokens
    }
    case 'tool_result': {
      const content = p.content;
      let total = 0;
      if (typeof content === 'string') {
        total = countTextTokens(content);
      } else if (Array.isArray(content)) {
        for (const inner of content) total += countPartTokens(inner);
      }
      return total + 6; // Tool result metadata tokens
    }
    default:
      return 0;
  }
}

/**
 * Counts exact tokens of a single canonical message including role delimiter overhead.
 */
export function countMessageTokens(message: CanonicalMessage): number {
  const roleOverhead = 4; // <|im_start|>role\n ... <|im_end|>\n
  let bodyTokens = 0;

  if (typeof message.content === 'string') {
    bodyTokens = countTextTokens(message.content);
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      bodyTokens += countPartTokens(part);
    }
  }

  if (message.name) {
    bodyTokens += countTextTokens(message.name);
  }
  if (message.toolCallId) {
    bodyTokens += countTextTokens(message.toolCallId);
  }

  return bodyTokens + roleOverhead;
}

export interface RealPromptTokenCount {
  messagesTokens: number;
  systemTokens: number;
  toolsTokens: number;
  total: number;
}

/**
 * Counts real prompt tokens at the gateway edge before forwarding to upstream.
 */
export function countPromptTokens(req: {
  messages?: CanonicalMessage[];
  systemPrompt?: string;
  tools?: Array<{
    type: string;
    function: { name: string; description?: string; parameters?: Record<string, unknown> };
  }>;
}): RealPromptTokenCount {
  let messagesTokens = 0;
  if (req.messages && Array.isArray(req.messages)) {
    for (const m of req.messages) {
      messagesTokens += countMessageTokens(m);
    }
    messagesTokens += 3; // Priming tokens (<|im_start|>assistant\n)
  }

  let systemTokens = 0;
  if (req.systemPrompt) {
    systemTokens = countTextTokens(req.systemPrompt) + 4;
  }

  let toolsTokens = 0;
  if (req.tools && Array.isArray(req.tools) && req.tools.length > 0) {
    for (const t of req.tools) {
      const fnName = t.function?.name ? countTextTokens(t.function.name) : 0;
      const fnDesc = t.function?.description ? countTextTokens(t.function.description) : 0;
      const fnParams = t.function?.parameters
        ? countTextTokens(JSON.stringify(t.function.parameters))
        : 0;
      toolsTokens += fnName + fnDesc + fnParams + 8;
    }
  }

  const total = messagesTokens + systemTokens + toolsTokens;
  return {
    messagesTokens,
    systemTokens,
    toolsTokens,
    total,
  };
}

/**
 * Counts exact completion tokens for non-streaming canonical content parts or string.
 */
export function countCompletionTokens(content: CanonicalContentPart[] | string): number {
  if (typeof content === 'string') {
    return countTextTokens(content);
  }
  if (!Array.isArray(content)) return 0;

  let total = 0;
  for (const part of content) {
    total += countPartTokens(part);
  }
  return total;
}
