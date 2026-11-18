import type { CanonicalMessage } from '../core/types/canonical';

const CHARS_PER_TOKEN = 4;

function partTextLength(part: unknown): number {
  if (!part || typeof part !== 'object') return 0;
  const p = part as Record<string, unknown>;
  switch (p.type) {
    case 'text':
      return typeof p.text === 'string' ? p.text.length : 0;
    case 'image':
      return 1000;
    case 'thinking':
      return typeof p.thinking === 'string' ? p.thinking.length : 0;
    case 'redacted_thinking':
      return typeof p.data === 'string' ? p.data.length : 0;
    case 'tool_use': {
      const inputStr = typeof p.input === 'string' ? p.input : JSON.stringify(p.input ?? {});
      const nameLen = typeof p.name === 'string' ? p.name.length : 0;
      return nameLen + inputStr.length + 50;
    }
    case 'tool_result': {
      const content = p.content;
      let len = 0;
      if (typeof content === 'string') {
        len = content.length;
      } else if (Array.isArray(content)) {
        for (const inner of content) len += partTextLength(inner);
      }
      return len + 100;
    }
    default:
      return 0;
  }
}

function messageTokenEstimate(message: CanonicalMessage): number {
  const roleOverhead = 4;
  let bodyLen = 0;
  if (typeof message.content === 'string') {
    bodyLen = message.content.length;
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) bodyLen += partTextLength(part);
  }
  if (message.name) bodyLen += message.name.length;
  if (message.toolCallId) bodyLen += message.toolCallId.length;
  return Math.ceil((bodyLen + roleOverhead) / CHARS_PER_TOKEN);
}

export function estimateMessagesTokens(messages: CanonicalMessage[]): number {
  let total = 0;
  for (const m of messages) total += messageTokenEstimate(m);
  return total + 3;
}

export function estimateSystemPromptTokens(systemPrompt?: string): number {
  if (!systemPrompt) return 0;
  return Math.ceil(systemPrompt.length / CHARS_PER_TOKEN);
}

export function estimateToolsTokens(
  tools?: Array<{ type: string; function: { name: string; description?: string; parameters?: Record<string, unknown> } }>
): number {
  if (!tools || tools.length === 0) return 0;
  let total = 0;
  for (const t of tools) {
    total += Math.ceil(t.function.name.length / CHARS_PER_TOKEN);
    if (t.function.description) {
      total += Math.ceil(t.function.description.length / CHARS_PER_TOKEN);
    }
    if (t.function.parameters) {
      total += Math.ceil(JSON.stringify(t.function.parameters).length / CHARS_PER_TOKEN);
    }
    total += 4;
  }
  return total;
}

export interface PromptTokenEstimate {
  messagesTokens: number;
  systemTokens: number;
  toolsTokens: number;
  total: number;
}

export {
  countTextTokens,
  countPartTokens,
  countMessageTokens,
  countPromptTokens,
  countCompletionTokens,
} from './token-counter';

export function estimatePromptTokens(req: {
  messages: CanonicalMessage[];
  systemPrompt?: string;
  tools?: Array<{ type: string; function: { name: string; description?: string; parameters?: Record<string, unknown> } }>;
}): PromptTokenEstimate {
  const messagesTokens = estimateMessagesTokens(req.messages);
  const systemTokens = estimateSystemPromptTokens(req.systemPrompt);
  const toolsTokens = estimateToolsTokens(req.tools);
  return {
    messagesTokens,
    systemTokens,
    toolsTokens,
    total: messagesTokens + systemTokens + toolsTokens + 4,
  };
}