import { globalPluginRegistry } from '../plugins/registry';
import { globalComboManager } from '../pool/combos';
import { globalAccountPool } from '../pool/account-pool';
import { resolveTargetProviderId } from '../utils/model-resolver';
import {
  getGlobalModelPassportStore,
  verifyPassport,
  type ModelPassport,
  type ModelPassportStore,
  type PassportEvidenceSource,
} from '../core/model-passports';
import { withRequestDeadline } from '../utils/request-deadline';

export interface ModelBadge {
  text: string;
  color: 'emerald' | 'amber' | 'coral' | 'zinc' | 'cyan';
}

export interface EnrichedModelCatalogItem {
  id: string;
  name: string;
  providerId: string;
  ownedBy: string;
  contextWindow?: number;
  contextWindowFormatted?: string;
  maxOutputTokens?: number;
  maxOutputTokensFormatted?: string;
  supportsThinking?: boolean;
  supportsTools?: boolean;
  supportsStreaming?: boolean;
  isFree?: boolean;
  tags: string[];
  badges: ModelBadge[];
  description?: string;
  verificationStatus?: 'unverified' | PassportEvidenceSource;
  passportDigest?: string;
  claimSources?: Record<string, PassportEvidenceSource>;
  available?: boolean;
  unavailableReason?: string;
}

/** Providers that work without an operator-supplied credential. */
const KEYLESS_PROVIDERS = new Set(['opencode', 'freellmapi']);

export function isProviderConfigured(providerId: string): { available: boolean; reason?: string } {
  if (globalPluginRegistry.has(providerId) && !globalPluginRegistry.isEnabled(providerId)) {
    return { available: false, reason: 'Provider plugin is disabled' };
  }
  if (KEYLESS_PROVIDERS.has(providerId)) return { available: true };
  const active = globalAccountPool.listAccounts(providerId).some((a) => a.status === 'active');
  return active
    ? { available: true }
    : { available: false, reason: 'No active account configured for this provider' };
}

export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    if (tokens === 1_048_576) return '1M tokens';
    const m = (tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 2);
    return `${m}M tokens`;
  }
  if (tokens % 1024 === 0) {
    return `${tokens / 1024}k tokens`;
  }
  if (tokens >= 1_000) {
    const k = Math.round(tokens / 1_000);
    return `${k}k tokens`;
  }
  return `${tokens.toLocaleString()} tokens`;
}

export function formatOutputTokens(tokens?: number): string {
  if (!tokens) return '8k tokens';
  if (tokens >= 1_000_000) {
    if (tokens === 1_048_576) return '1M tokens';
    const m = (tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 2);
    return `${m}M tokens`;
  }
  if (tokens % 1024 === 0) {
    return `${tokens / 1024}k tokens`;
  }
  if (tokens >= 1_000) {
    const k = Math.round(tokens / 1_000);
    return `${k}k tokens`;
  }
  return `${tokens.toLocaleString()} tokens`;
}

// Canonical inventory of verified zero-cost free models across upstreams
export const CANONICAL_FREE_MODELS: EnrichedModelCatalogItem[] = [
  // --------------------------------------------------------------------------
  // Kilo Code Free Models (16 models, 4 with 1M context)
  // --------------------------------------------------------------------------
  {
    id: 'kilo/particle-ai/particle-1:free',
    name: 'Particle AI Particle 1 Free (1M Context)',
    providerId: 'kilo',
    ownedBy: 'particle-ai',
    contextWindow: 1_048_576,
    contextWindowFormatted: '1M tokens (1,048,576)',
    maxOutputTokens: 16_384,
    maxOutputTokensFormatted: '16k tokens',
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['1M Context', 'Reasoning', 'Fast', 'Free'],
    badges: [
      { text: '1M Context', color: 'emerald' },
      { text: 'Reasoning', color: 'amber' },
      { text: 'Fast', color: 'coral' },
      { text: 'Free', color: 'emerald' },
    ],
    description: 'Particle AI 1M large-context engine with active reasoning tokens and zero rate-drop.',
  },
  {
    id: 'kilo/baidu/ernie-5.5-flash-preview:free',
    name: 'Baidu Ernie 5.5 Flash Preview Free (1M Context)',
    providerId: 'kilo',
    ownedBy: 'baidu',
    contextWindow: 1_024_000,
    contextWindowFormatted: '1M tokens (1,024,000)',
    maxOutputTokens: 8_192,
    maxOutputTokensFormatted: '8k tokens',
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['1M Context', 'Reasoning', 'Preview', 'Free'],
    badges: [
      { text: '1M Context', color: 'emerald' },
      { text: 'Reasoning', color: 'amber' },
      { text: 'Preview', color: 'zinc' },
      { text: 'Free', color: 'emerald' },
    ],
    description: 'Baidu flagship reasoning engine with native million-token comprehension.',
  },
  {
    id: 'kilo/nvidia/nemotron-3.5-lightning:free',
    name: 'NVIDIA Nemotron 3.5 Lightning Free (1M Context)',
    providerId: 'kilo',
    ownedBy: 'nvidia',
    contextWindow: 1_000_000,
    contextWindowFormatted: '1M tokens (1,000,000)',
    maxOutputTokens: 16_384,
    maxOutputTokensFormatted: '16k tokens',
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['1M Context', 'Reasoning', 'Lightning', 'Free'],
    badges: [
      { text: '1M Context', color: 'emerald' },
      { text: 'Reasoning', color: 'amber' },
      { text: 'Lightning', color: 'coral' },
      { text: 'Free', color: 'emerald' },
    ],
    description: 'Ultra-low-latency 1M context NVIDIA model optimized for rapid workspace scanning.',
  },
  {
    id: 'kilo/inclusionai/ling-3.2-flash:free',
    name: 'InclusionAI Ling 3.2 Flash Free (1M Context)',
    providerId: 'kilo',
    ownedBy: 'inclusionai',
    contextWindow: 1_048_576,
    contextWindowFormatted: '1M tokens (1,048,576)',
    maxOutputTokens: 8_192,
    maxOutputTokensFormatted: '8k tokens',
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['1M Context', 'Reasoning', 'Flash', 'Free'],
    badges: [
      { text: '1M Context', color: 'emerald' },
      { text: 'Reasoning', color: 'amber' },
      { text: 'Flash', color: 'coral' },
      { text: 'Free', color: 'emerald' },
    ],
    description: 'High-throughput 1M context engine with enhanced multilingual support.',
  },
  {
    id: 'kilo/nvidia/nemotron-3.5-super-vl:free',
    name: 'NVIDIA Nemotron 3.5 Super VL Free',
    providerId: 'kilo',
    ownedBy: 'nvidia',
    contextWindow: 128_000,
    contextWindowFormatted: '128k tokens',
    maxOutputTokens: 4_096,
    maxOutputTokensFormatted: '4k tokens',
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['Vision', 'Reasoning', 'Free'],
    badges: [
      { text: 'Vision', color: 'cyan' },
      { text: 'Reasoning', color: 'amber' },
      { text: 'Free', color: 'emerald' },
    ],
    description: 'Vision-language model with multimodal image comprehension and tool-calling.',
  },
  {
    id: 'kilo/nvidia/nemotron-3-ultra-550b-a55b:free',
    name: 'NVIDIA Nemotron 3 Ultra 550B Free',
    providerId: 'kilo',
    ownedBy: 'nvidia',
    contextWindow: 128_000,
    contextWindowFormatted: '128k tokens',
    maxOutputTokens: 8_192,
    maxOutputTokensFormatted: '8k tokens',
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['Massive', 'Reasoning', 'Free'],
    badges: [
      { text: 'Massive', color: 'zinc' },
      { text: 'Reasoning', color: 'amber' },
      { text: 'Free', color: 'emerald' },
    ],
    description: 'Massive 550B parameter frontier model with deep domain reasoning.',
  },
  {
    id: 'kilo/qwen-2.5-coder:free',
    name: 'Kilo Qwen 2.5 Coder Free',
    providerId: 'kilo',
    ownedBy: 'kilo',
    contextWindow: 131_072,
    contextWindowFormatted: '128k tokens',
    maxOutputTokens: 8_192,
    maxOutputTokensFormatted: '8k tokens',
    supportsThinking: false,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['Coding', 'Fast', 'Free'],
    badges: [
      { text: 'Coding', color: 'zinc' },
      { text: 'Fast', color: 'coral' },
      { text: 'Free', color: 'emerald' },
    ],
    description: 'Specialized code completion and generation engine optimized for software engineering.',
  },
  {
    id: 'kilo/qwen/qwen-2.5-72b-instruct:free',
    name: 'Qwen 2.5 72B Instruct Free',
    providerId: 'kilo',
    ownedBy: 'qwen',
    contextWindow: 131_072,
    contextWindowFormatted: '128k tokens',
    maxOutputTokens: 8_192,
    maxOutputTokensFormatted: '8k tokens',
    supportsThinking: false,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['General', 'Instruct', 'Free'],
    badges: [
      { text: '72B High Quality', color: 'amber' },
      { text: 'Instruct', color: 'zinc' },
      { text: 'Free', color: 'emerald' },
    ],
    description: 'Alibaba Qwen 2.5 72B instruct model with exceptional reasoning and knowledge breadth.',
  },
  {
    id: 'kilo/deepseek-r1:free',
    name: 'DeepSeek R1 Free (via Kilo)',
    providerId: 'kilo',
    ownedBy: 'deepseek',
    contextWindow: 128_000,
    contextWindowFormatted: '128k tokens',
    maxOutputTokens: 8_192,
    maxOutputTokensFormatted: '8k tokens',
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['Reasoning', 'R1', 'Free'],
    badges: [
      { text: 'Reasoning', color: 'amber' },
      { text: 'R1 Chain', color: 'coral' },
      { text: 'Free', color: 'emerald' },
    ],
    description: 'Frontier open-weights reasoning model with explicit visible chain-of-thought tokens.',
  },
  {
    id: 'kilo/deepseek-v3:free',
    name: 'DeepSeek V3 Free (via Kilo)',
    providerId: 'kilo',
    ownedBy: 'deepseek',
    contextWindow: 128_000,
    contextWindowFormatted: '128k tokens',
    maxOutputTokens: 8_192,
    maxOutputTokensFormatted: '8k tokens',
    supportsThinking: false,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['Coding', 'V3', 'Free'],
    badges: [
      { text: 'Coding', color: 'zinc' },
      { text: 'V3 Speed', color: 'coral' },
      { text: 'Free', color: 'emerald' },
    ],
    description: 'High-speed DeepSeek V3 general chat and coding engine with zero subscription fees.',
  },
  {
    id: 'kilo/cohere/north-mini-code:free',
    name: 'Cohere North Mini Code Free',
    providerId: 'kilo',
    ownedBy: 'cohere',
    contextWindow: 128_000,
    contextWindowFormatted: '128k tokens',
    maxOutputTokens: 4_096,
    maxOutputTokensFormatted: '4k tokens',
    supportsThinking: false,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['Coding', 'Compact', 'Free'],
    badges: [
      { text: 'Compact', color: 'zinc' },
      { text: 'Coding', color: 'coral' },
      { text: 'Free', color: 'emerald' },
    ],
    description: 'Cohere specialized code intelligence model optimized for compact code edits.',
  },
  {
    id: 'kilo/code-fast:free',
    name: 'Kilo Code Fast (Free Tier)',
    providerId: 'kilo',
    ownedBy: 'kilo',
    contextWindow: 128_000,
    contextWindowFormatted: '128k tokens',
    maxOutputTokens: 8_192,
    maxOutputTokensFormatted: '8k tokens',
    supportsThinking: false,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['Fast', 'Coding', 'Free'],
    badges: [
      { text: 'Fast', color: 'coral' },
      { text: 'Coding', color: 'zinc' },
      { text: 'Free', color: 'emerald' },
    ],
    description: 'Optimized rapid response coding tier with sub-100ms first token latency.',
  },
  {
    id: 'kilo/liquid/lfm-3-1.7b:free',
    name: 'Liquid LFM 3 1.7B Free',
    providerId: 'kilo',
    ownedBy: 'liquid',
    contextWindow: 32_768,
    contextWindowFormatted: '32k tokens',
    maxOutputTokens: 4_096,
    maxOutputTokensFormatted: '4k tokens',
    supportsThinking: false,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['Ultra-Fast', 'Tiny 1.7B', 'Free'],
    badges: [
      { text: 'Ultra-Fast', color: 'coral' },
      { text: '1.7B Tiny', color: 'zinc' },
      { text: 'Free', color: 'emerald' },
    ],
    description: 'Liquid neural network architecture with constant memory scaling (32k context, 4k output).',
  },
  {
    id: 'kilo/free-model:free',
    name: 'Kilo Free Model',
    providerId: 'kilo',
    ownedBy: 'kilo',
    contextWindow: 128_000,
    contextWindowFormatted: '128k tokens',
    maxOutputTokens: 8_192,
    maxOutputTokensFormatted: '8k tokens',
    supportsThinking: false,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['General', 'Free'],
    badges: [
      { text: 'General', color: 'zinc' },
      { text: 'Free', color: 'emerald' },
    ],
    description: 'Standard zero-cost general capability model for quick tasks.',
  },
  {
    id: 'kilo/kilo-auto/free',
    name: 'Kilo Auto Free Router',
    providerId: 'kilo',
    ownedBy: 'kilo',
    contextWindow: 128_000,
    contextWindowFormatted: '128k tokens',
    maxOutputTokens: 8_192,
    maxOutputTokensFormatted: '8k tokens',
    supportsThinking: false,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['Auto Router', 'Free'],
    badges: [
      { text: 'Auto Router', color: 'amber' },
      { text: 'Free', color: 'emerald' },
    ],
    description: 'Intelligent upstream dynamic dispatcher routing to least-loaded free endpoints.',
  },

  // --------------------------------------------------------------------------
  // Cline Pooled Accounts Free Models (5 models, 2 with 1M context)
  // --------------------------------------------------------------------------
  {
    id: 'cline-free/step-5-preview',
    name: 'Cline Free Step-5 Preview',
    providerId: 'cline',
    ownedBy: 'cline',
    contextWindow: 1_000_000,
    contextWindowFormatted: '1M tokens (1,000,000)',
    maxOutputTokens: 8_192,
    maxOutputTokensFormatted: '8k tokens',
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['1M Context', 'Reasoning', 'Free'],
    badges: [
      { text: '1M Context', color: 'emerald' },
      { text: 'Reasoning', color: 'amber' },
      { text: 'Free', color: 'emerald' },
    ],
    description: 'WorkOS pooled Step-5 frontier model with 1,000,000 token context window.',
  },
  {
    id: 'cline-free/mimo-v2.6-flash',
    name: 'Cline Free Mimo V2.6 Flash',
    providerId: 'cline',
    ownedBy: 'cline',
    contextWindow: 200_000,
    contextWindowFormatted: '200k tokens',
    maxOutputTokens: 32_000,
    maxOutputTokensFormatted: '32k tokens',
    supportsThinking: false,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['Fast', 'Free'],
    badges: [
      { text: 'Fast', color: 'coral' },
      { text: '200k Context', color: 'emerald' },
      { text: 'Free', color: 'emerald' },
    ],
    description: 'Lightweight high-speed model with verified 200k context window and 32k output limit.',
  },
  {
    id: 'cline-free/solar-mini4',
    name: 'Cline Free Solar Mini 4',
    providerId: 'cline',
    ownedBy: 'cline',
    contextWindow: 128_000,
    contextWindowFormatted: '128k tokens',
    maxOutputTokens: 4_096,
    maxOutputTokensFormatted: '4k tokens',
    supportsThinking: false,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['Fast', 'Free'],
    badges: [
      { text: 'Fast', color: 'coral' },
      { text: 'Free', color: 'emerald' },
    ],
    description: 'Upstage Solar Mini 4 model routed through active WorkOS device pools.',
  },
  {
    id: 'reflection/beam-free',
    name: 'Cline Free Beam 1.0 (1M Context)',
    providerId: 'cline',
    ownedBy: 'reflection',
    contextWindow: 1_048_576,
    contextWindowFormatted: '1M tokens (1,048,576)',
    maxOutputTokens: 131_072,
    maxOutputTokensFormatted: '128k tokens',
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['1M Context', 'Reasoning', 'Free'],
    badges: [
      { text: '1M Context', color: 'emerald' },
      { text: '128k Output', color: 'cyan' },
      { text: 'Reasoning', color: 'amber' },
      { text: 'Free', color: 'emerald' },
    ],
    description: 'WorkOS pooled Reflection Beam 1.0 free model with 1,048,576 context and massive 128k generation limit.',
  },
  {
    id: 'poolside/laguna-s-2.1-free',
    name: 'Cline Free Laguna S 2.1',
    providerId: 'cline',
    ownedBy: 'poolside',
    contextWindow: 256_000,
    contextWindowFormatted: '256k tokens',
    maxOutputTokens: 32_768,
    maxOutputTokensFormatted: '32k tokens',
    supportsThinking: false,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['Fast', 'Coding', 'Free'],
    badges: [
      { text: '256k Context', color: 'emerald' },
      { text: 'Coding', color: 'zinc' },
      { text: 'Free', color: 'emerald' },
    ],
    description: 'Poolside Laguna S 2.1 model for high-efficiency code editing via Cline free pool.',
  },

  // --------------------------------------------------------------------------
  // DeepSeek Web Pool Free Models (4 models)
  // --------------------------------------------------------------------------
  {
    id: 'deepseek/deepseek-chat',
    name: 'DeepSeek Chat (Web Session Pool)',
    providerId: 'deepseek',
    ownedBy: 'deepseek',
    contextWindow: 64_000,
    contextWindowFormatted: '64k tokens',
    maxOutputTokens: 8_192,
    maxOutputTokensFormatted: '8k tokens',
    supportsThinking: false,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['Web Pool', 'General', 'Free'],
    badges: [
      { text: 'Web Pool', color: 'cyan' },
      { text: 'General', color: 'zinc' },
      { text: 'Free', color: 'emerald' },
    ],
    description: 'Direct browser cookie session pool with automatic WAF bypass and rotating headers.',
  },
  {
    id: 'deepseek/deepseek-reasoner',
    name: 'DeepSeek Reasoner R1 (Web Session Pool)',
    providerId: 'deepseek',
    ownedBy: 'deepseek',
    contextWindow: 64_000,
    contextWindowFormatted: '64k tokens',
    maxOutputTokens: 8_192,
    maxOutputTokensFormatted: '8k tokens',
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['Web Pool', 'Reasoning', 'R1', 'Free'],
    badges: [
      { text: 'Web Pool', color: 'cyan' },
      { text: 'Reasoning R1', color: 'amber' },
      { text: 'Free', color: 'emerald' },
    ],
    description: 'Reasoning model streaming live thought tokens through authentic Chrome extension session cookies.',
  },
  {
    id: 'deepseek/deepseek-v3',
    name: 'DeepSeek V3 Web Direct',
    providerId: 'deepseek',
    ownedBy: 'deepseek',
    contextWindow: 64_000,
    contextWindowFormatted: '64k tokens',
    maxOutputTokens: 8_192,
    maxOutputTokensFormatted: '8k tokens',
    supportsThinking: false,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['Web Pool', 'Coding', 'Free'],
    badges: [
      { text: 'Web Pool', color: 'cyan' },
      { text: 'Coding', color: 'zinc' },
      { text: 'Free', color: 'emerald' },
    ],
    description: 'Direct V3 dialect mapping to free web session tokens with keep-alive streaming.',
  },
  {
    id: 'deepseek/deepseek-r1',
    name: 'DeepSeek R1 Web Direct',
    providerId: 'deepseek',
    ownedBy: 'deepseek',
    contextWindow: 64_000,
    contextWindowFormatted: '64k tokens',
    maxOutputTokens: 8_192,
    maxOutputTokensFormatted: '8k tokens',
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['Web Pool', 'Reasoning', 'Free'],
    badges: [
      { text: 'Web Pool', color: 'cyan' },
      { text: 'Reasoning', color: 'amber' },
      { text: 'Free', color: 'emerald' },
    ],
    description: 'Full-depth R1 chain-of-thought execution via authenticated session pool.',
  },

  // --------------------------------------------------------------------------
  // OpenCode Zen Keyless Models (8 models, 3 with 1M context)
  // --------------------------------------------------------------------------
  {
    id: 'big-pickle',
    name: 'OpenCode Big Pickle (Free Keyless)',
    providerId: 'opencode',
    ownedBy: 'opencode',
    contextWindow: 200_000,
    contextWindowFormatted: '200k tokens',
    maxOutputTokens: 32_000,
    maxOutputTokensFormatted: '32k tokens',
    supportsThinking: false,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['Keyless', 'Coding', 'Fast', 'Free'],
    badges: [
      { text: 'Keyless', color: 'cyan' },
      { text: 'Coding', color: 'zinc' },
      { text: 'Fast', color: 'coral' },
      { text: 'Free', color: 'emerald' },
    ],
    description: 'Anonymous keyless model with 12 gate tools injected automatically on each session.',
  },
  {
    id: 'mimo-v2.6-flash-free',
    name: 'Mimo V2.6 Flash (Free Keyless)',
    providerId: 'opencode',
    ownedBy: 'opencode',
    contextWindow: 200_000,
    contextWindowFormatted: '200k tokens',
    maxOutputTokens: 32_000,
    maxOutputTokensFormatted: '32k tokens',
    supportsThinking: false,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['Keyless', 'Fast', 'Free'],
    badges: [
      { text: 'Keyless', color: 'cyan' },
      { text: 'Fast', color: 'coral' },
      { text: 'Free', color: 'emerald' },
    ],
    description: 'Fast keyless inference with 200k context window and zero credential overhead.',
  },
  {
    id: 'deepseek-v4.1-flash-free',
    name: 'DeepSeek V4.1 Flash (Free Keyless)',
    providerId: 'opencode',
    ownedBy: 'opencode',
    contextWindow: 128_000,
    contextWindowFormatted: '128k tokens',
    maxOutputTokens: 16_000,
    maxOutputTokensFormatted: '16k tokens',
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['Keyless', 'Reasoning', 'Coding', 'Free'],
    badges: [
      { text: 'Keyless', color: 'cyan' },
      { text: 'Reasoning', color: 'amber' },
      { text: 'Coding', color: 'zinc' },
      { text: 'Free', color: 'emerald' },
    ],
    description: 'Keyless DeepSeek coding & reasoning model with auto-minted anonymous tokens.',
  },
  {
    id: 'nemotron-3.5-lightning-free',
    name: 'Nemotron 3.5 Lightning (Free Keyless)',
    providerId: 'opencode',
    ownedBy: 'opencode',
    contextWindow: 262_144,
    contextWindowFormatted: '262k tokens',
    maxOutputTokens: 16_384,
    maxOutputTokensFormatted: '16k tokens',
    supportsThinking: false,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['Keyless', 'Fast', 'Large Context', 'Free'],
    badges: [
      { text: 'Keyless', color: 'cyan' },
      { text: 'Large Context', color: 'emerald' },
      { text: 'Fast', color: 'coral' },
      { text: 'Free', color: 'emerald' },
    ],
    description: '262k quarter-million token context model completely free without API keys.',
  },
  {
    id: 'muse-spark-1.3-contributor-free',
    name: 'OpenCode Muse Spark 1.3 (1M Context Free)',
    providerId: 'opencode',
    ownedBy: 'opencode',
    contextWindow: 1_048_576,
    contextWindowFormatted: '1M tokens (1,048,576)',
    maxOutputTokens: 131_072,
    maxOutputTokensFormatted: '128k tokens',
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['Keyless', '1M Context', 'Reasoning', 'Free'],
    badges: [
      { text: 'Keyless', color: 'cyan' },
      { text: '1M Context', color: 'emerald' },
      { text: '128k Output', color: 'cyan' },
      { text: 'Free', color: 'emerald' },
    ],
    description: 'OpenCode Zen contributor tier model featuring 1,048,576 token context and 128k output ceiling.',
  },
  {
    id: 'muse-spark-1.2-contributor-free',
    name: 'OpenCode Muse Spark 1.2 (1M Context Free)',
    providerId: 'opencode',
    ownedBy: 'opencode',
    contextWindow: 1_048_576,
    contextWindowFormatted: '1M tokens (1,048,576)',
    maxOutputTokens: 131_072,
    maxOutputTokensFormatted: '128k tokens',
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['Keyless', '1M Context', 'Reasoning', 'Free'],
    badges: [
      { text: 'Keyless', color: 'cyan' },
      { text: '1M Context', color: 'emerald' },
      { text: 'Free', color: 'emerald' },
    ],
    description: 'Ultra-stable Muse Spark 1.2 free model with full 1M context capacity.',
  },
  {
    id: 'nemotron-3-ultra-free',
    name: 'OpenCode Nemotron 3 Ultra (1M Context Free)',
    providerId: 'opencode',
    ownedBy: 'opencode',
    contextWindow: 1_000_000,
    contextWindowFormatted: '1M tokens (1,000,000)',
    maxOutputTokens: 128_000,
    maxOutputTokensFormatted: '128k tokens',
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['Keyless', '1M Context', 'Massive', 'Free'],
    badges: [
      { text: 'Keyless', color: 'cyan' },
      { text: '1M Context', color: 'emerald' },
      { text: 'Free', color: 'emerald' },
    ],
    description: 'NVIDIA Nemotron 3 Ultra 1M context anonymous model for large code repos.',
  },
  {
    id: 'ling-3.0-flash-fin-free',
    name: 'OpenCode Ling 3.0 Flash Fin (Free)',
    providerId: 'opencode',
    ownedBy: 'opencode',
    contextWindow: 262_144,
    contextWindowFormatted: '262k tokens',
    maxOutputTokens: 32_768,
    maxOutputTokensFormatted: '32k tokens',
    supportsThinking: false,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['Keyless', 'Fast', 'Free'],
    badges: [
      { text: 'Keyless', color: 'cyan' },
      { text: '262k Context', color: 'emerald' },
      { text: 'Free', color: 'emerald' },
    ],
    description: 'Fast financial & analytical model with 262k context and zero key requirement.',
  },

  // --------------------------------------------------------------------------
  // Nous Research Free Models (3 models)
  // --------------------------------------------------------------------------
  {
    id: 'nous/upstage/solar-mini4:free',
    name: 'Nous Solar Mini 4 Free',
    providerId: 'nous',
    ownedBy: 'upstage',
    contextWindow: 128_000,
    contextWindowFormatted: '128k tokens',
    maxOutputTokens: 4_096,
    maxOutputTokensFormatted: '4k tokens',
    supportsThinking: false,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['Fast', 'Free'],
    badges: [
      { text: 'Fast', color: 'coral' },
      { text: 'Free', color: 'emerald' },
    ],
    description: 'High speed open weights model hosted on Nous portal infrastructure.',
  },
  {
    id: 'nous/stepfun/step-3.7-flash:free',
    name: 'Nous Step 3.7 Flash Free',
    providerId: 'nous',
    ownedBy: 'stepfun',
    contextWindow: 128_000,
    contextWindowFormatted: '128k tokens',
    maxOutputTokens: 8_192,
    maxOutputTokensFormatted: '8k tokens',
    supportsThinking: false,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['Reasoning', 'Free'],
    badges: [
      { text: 'Reasoning', color: 'amber' },
      { text: 'Free', color: 'emerald' },
    ],
    description: 'Stepfun high-efficiency model with fast analytical responses.',
  },
  {
    id: 'nous/meituan/longcat-2.5:free',
    name: 'Nous Longcat 2.5 Free',
    providerId: 'nous',
    ownedBy: 'meituan',
    contextWindow: 128_000,
    contextWindowFormatted: '128k tokens',
    maxOutputTokens: 8_192,
    maxOutputTokensFormatted: '8k tokens',
    supportsThinking: false,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['Large Context', 'Free'],
    badges: [
      { text: 'Long Context', color: 'zinc' },
      { text: 'Free', color: 'emerald' },
    ],
    description: 'Long-context reasoning engine with robust multi-turn instruction adherence.',
  },

  // --------------------------------------------------------------------------
  // Groq Free Tier Models (3 models)
  // --------------------------------------------------------------------------
  {
    id: 'groq/llama-3.3-70b-versatile',
    name: 'Groq Llama 3.3 70B Versatile (Free Tier)',
    providerId: 'groq',
    ownedBy: 'meta',
    contextWindow: 128_000,
    contextWindowFormatted: '128k tokens',
    maxOutputTokens: 32_768,
    maxOutputTokensFormatted: '32k tokens',
    supportsThinking: false,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['Groq LPU', 'Ultra-Fast', 'Coding', 'Free'],
    badges: [
      { text: 'Groq LPU', color: 'amber' },
      { text: '32k Output', color: 'cyan' },
      { text: 'Free Tier', color: 'emerald' },
    ],
    description: 'Llama 3.3 70B served via Groq LPUs at 300+ tokens/sec with 128k context and 32k output limit.',
  },
  {
    id: 'groq/llama-3.1-8b-instant',
    name: 'Groq Llama 3.1 8B Instant (Free Tier)',
    providerId: 'groq',
    ownedBy: 'meta',
    contextWindow: 128_000,
    contextWindowFormatted: '128k tokens',
    maxOutputTokens: 8_192,
    maxOutputTokensFormatted: '8k tokens',
    supportsThinking: false,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['Groq LPU', 'Instant', 'Free'],
    badges: [
      { text: 'Groq Instant', color: 'coral' },
      { text: 'Free Tier', color: 'emerald' },
    ],
    description: 'Lightning-fast 8B model with sub-50ms TTFT running on Groq free developer tier.',
  },
  {
    id: 'groq/deepseek-r1-distill-llama-70b',
    name: 'Groq DeepSeek R1 Distill 70B (Free Tier)',
    providerId: 'groq',
    ownedBy: 'deepseek',
    contextWindow: 128_000,
    contextWindowFormatted: '128k tokens',
    maxOutputTokens: 8_192,
    maxOutputTokensFormatted: '8k tokens',
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['Groq LPU', 'Reasoning', 'R1', 'Free'],
    badges: [
      { text: 'Reasoning R1', color: 'amber' },
      { text: 'Groq LPU', color: 'coral' },
      { text: 'Free Tier', color: 'emerald' },
    ],
    description: 'Distilled DeepSeek R1 reasoning architecture accelerated by Groq hardware.',
  },

  // --------------------------------------------------------------------------
  // Google Gemini Free Tier Models (2 models, both 1M context)
  // --------------------------------------------------------------------------
  {
    id: 'gemini-2.0-flash',
    name: 'Google Gemini 2.0 Flash (Free Tier)',
    providerId: 'gemini',
    ownedBy: 'google',
    contextWindow: 1_048_576,
    contextWindowFormatted: '1M tokens (1,048,576)',
    maxOutputTokens: 8_192,
    maxOutputTokensFormatted: '8k tokens',
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['1M Context', 'Multimodal', 'Free'],
    badges: [
      { text: '1M Context', color: 'emerald' },
      { text: 'Multimodal', color: 'cyan' },
      { text: 'Free Tier', color: 'emerald' },
    ],
    description: 'Google AI Studio zero-cost tier model with native 1,048,576 token context and multimodal capabilities.',
  },
  {
    id: 'gemini-2.0-flash-thinking-exp',
    name: 'Google Gemini 2.0 Flash Thinking (1M Context Free)',
    providerId: 'gemini',
    ownedBy: 'google',
    contextWindow: 1_048_576,
    contextWindowFormatted: '1M tokens (1,048,576)',
    maxOutputTokens: 65_536,
    maxOutputTokensFormatted: '64k tokens',
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['1M Context', 'Reasoning', 'Thinking', 'Free'],
    badges: [
      { text: '1M Context', color: 'emerald' },
      { text: 'Reasoning', color: 'amber' },
      { text: '64k Output', color: 'cyan' },
      { text: 'Free Tier', color: 'emerald' },
    ],
    description: 'Experimental Gemini model with extended thinking reasoning traces and massive 64k token generation ceiling.',
  },

  // --------------------------------------------------------------------------
  // FreeLLMAPI Local Free Engine (8 verified 1M context models)
  // --------------------------------------------------------------------------
  {
    id: 'freellmapi/auto',
    name: 'FreeLLMAPI Auto Router (1M Context Free)',
    providerId: 'freellmapi',
    ownedBy: 'freellmapi',
    contextWindow: 1_048_576,
    contextWindowFormatted: '1M tokens (1,048,576)',
    maxOutputTokens: 8_192,
    maxOutputTokensFormatted: '8k tokens',
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['1M Context', 'Auto-Router', 'Free'],
    badges: [
      { text: '1M Context', color: 'emerald' },
      { text: 'Auto-Router', color: 'amber' },
      { text: 'Free Tier', color: 'emerald' },
    ],
    description: 'Dynamic local auto-router picking best available free 1M frontier model via FreeLLMAPI backend.',
  },
  {
    id: 'freellmapi/claude-sonnet-4-5',
    name: 'FreeLLMAPI Claude Sonnet 4.5 Slot (1M Context)',
    providerId: 'freellmapi',
    ownedBy: 'freellmapi',
    contextWindow: 1_048_576,
    contextWindowFormatted: '1M tokens (1,048,576)',
    maxOutputTokens: 8_192,
    maxOutputTokensFormatted: '8k tokens',
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['1M Context', 'Coding', 'Flagship', 'Free'],
    badges: [
      { text: '1M Context', color: 'emerald' },
      { text: 'Coding', color: 'coral' },
      { text: 'Free Tier', color: 'emerald' },
    ],
    description: 'FreeLLMAPI Sonnet slot automatically routed to top zero-cost frontier model with 1,048,576 context.',
  },
  {
    id: 'freellmapi/claude-opus-4-5',
    name: 'FreeLLMAPI Claude Opus 4.5 Slot (1M Context)',
    providerId: 'freellmapi',
    ownedBy: 'freellmapi',
    contextWindow: 1_048_576,
    contextWindowFormatted: '1M tokens (1,048,576)',
    maxOutputTokens: 8_192,
    maxOutputTokensFormatted: '8k tokens',
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['1M Context', 'Reasoning', 'Free'],
    badges: [
      { text: '1M Context', color: 'emerald' },
      { text: 'Reasoning', color: 'amber' },
      { text: 'Free Tier', color: 'emerald' },
    ],
    description: 'FreeLLMAPI Opus slot with high-capacity analytical reasoning at 1,048,576 context window.',
  },
  {
    id: 'freellmapi/claude-haiku-4-5',
    name: 'FreeLLMAPI Claude Haiku 4.5 Slot (1M Context)',
    providerId: 'freellmapi',
    ownedBy: 'freellmapi',
    contextWindow: 1_048_576,
    contextWindowFormatted: '1M tokens (1,048,576)',
    maxOutputTokens: 8_192,
    maxOutputTokensFormatted: '8k tokens',
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['1M Context', 'Fast', 'Free'],
    badges: [
      { text: '1M Context', color: 'emerald' },
      { text: 'Fast', color: 'cyan' },
      { text: 'Free Tier', color: 'emerald' },
    ],
    description: 'High-speed 1M token context window model for rapid iterations and small context tasks.',
  },
  {
    id: 'freellmapi/fusion',
    name: 'FreeLLMAPI Fusion Panel (1M Context)',
    providerId: 'freellmapi',
    ownedBy: 'freellmapi',
    contextWindow: 1_048_576,
    contextWindowFormatted: '1M tokens (1,048,576)',
    maxOutputTokens: 8_192,
    maxOutputTokensFormatted: '8k tokens',
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['1M Context', 'Panel-Judge', 'Free'],
    badges: [
      { text: '1M Context', color: 'emerald' },
      { text: 'Fusion', color: 'amber' },
      { text: 'Free Tier', color: 'emerald' },
    ],
    description: 'Panel of models answers in parallel with an automated judge synthesizing one cohesive response.',
  },
  {
    id: 'freellmapi/nemotron-3.5-lightning',
    name: 'FreeLLMAPI Nemotron 3.5 Lightning (1M Context)',
    providerId: 'freellmapi',
    ownedBy: 'freellmapi',
    contextWindow: 1_048_576,
    contextWindowFormatted: '1M tokens (1,048,576)',
    maxOutputTokens: 8_192,
    maxOutputTokensFormatted: '8k tokens',
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['1M Context', 'Lightning', 'Free'],
    badges: [
      { text: '1M Context', color: 'emerald' },
      { text: 'Lightning', color: 'coral' },
      { text: 'Free Tier', color: 'emerald' },
    ],
    description: 'NVIDIA Nemotron 3.5 Lightning served via FreeLLMAPI with 1,048,576 context length.',
  },
  {
    id: 'freellmapi/nemotron-3-ultra-550b',
    name: 'FreeLLMAPI Nemotron 3 Ultra 550B (1M Context)',
    providerId: 'freellmapi',
    ownedBy: 'freellmapi',
    contextWindow: 1_048_576,
    contextWindowFormatted: '1M tokens (1,048,576)',
    maxOutputTokens: 8_192,
    maxOutputTokensFormatted: '8k tokens',
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['1M Context', 'Ultra-550B', 'Free'],
    badges: [
      { text: '1M Context', color: 'emerald' },
      { text: '550B', color: 'amber' },
      { text: 'Free Tier', color: 'emerald' },
    ],
    description: 'NVIDIA Nemotron 3 Ultra 550B served via FreeLLMAPI with 1,048,576 context length.',
  },
  {
    id: 'freellmapi/nemotron-3.5-super-vl',
    name: 'FreeLLMAPI Nemotron 3.5 Super VL (1M Context)',
    providerId: 'freellmapi',
    ownedBy: 'freellmapi',
    contextWindow: 1_000_000,
    contextWindowFormatted: '1M tokens (1,000,000)',
    maxOutputTokens: 8_192,
    maxOutputTokensFormatted: '8k tokens',
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['1M Context', 'Vision', 'Free'],
    badges: [
      { text: '1M Context', color: 'emerald' },
      { text: 'Vision', color: 'cyan' },
      { text: 'Free Tier', color: 'emerald' },
    ],
    description: 'NVIDIA Nemotron 3.5 Super VL multimodal vision-language model with 1,000,000 context length.',
  },

  // --------------------------------------------------------------------------
  // Lattice Virtual Combos (2 auto-failover cascades)
  // --------------------------------------------------------------------------
  {
    id: 'lattice/1m-free',
    name: 'Lattice 1M Context Free Tier ($0 Auto-Failover)',
    providerId: 'lattice',
    ownedBy: 'lattice',
    contextWindow: 1_048_576,
    contextWindowFormatted: '1M tokens (1,048,576)',
    maxOutputTokens: 16_384,
    maxOutputTokensFormatted: '16k tokens',
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['1M Context', 'Auto-Failover', 'Virtual Combo', 'Free'],
    badges: [
      { text: '1M Context', color: 'emerald' },
      { text: 'Auto-Failover', color: 'amber' },
      { text: 'Virtual Combo', color: 'zinc' },
      { text: 'Free ($0)', color: 'emerald' },
    ],
    description: 'Multi-target cascade auto-failing over across all 1M free models with zero drops.',
  },
  {
    id: 'lattice/fast-free',
    name: 'Lattice Fast Free 0$ Tier',
    providerId: 'lattice',
    ownedBy: 'lattice',
    contextWindow: 200_000,
    contextWindowFormatted: '200k tokens',
    maxOutputTokens: 8_192,
    maxOutputTokensFormatted: '8k tokens',
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['Fast', 'Auto-Failover', 'Virtual Combo', 'Free'],
    badges: [
      { text: 'Fast', color: 'coral' },
      { text: 'Auto-Failover', color: 'amber' },
      { text: 'Virtual Combo', color: 'zinc' },
      { text: 'Free ($0)', color: 'emerald' },
    ],
    description: 'Zero-cost high-speed aggregator across Kilo, OpenCode Zen, and Nous endpoints.',
  },
];

export async function observeEnabledPluginCatalogs(
  store: ModelPassportStore = getGlobalModelPassportStore()
): Promise<ModelPassport[]> {
  const observed: ModelPassport[] = [];
  for (const plugin of globalPluginRegistry.getEnabled()) {
    try {
      for (const model of await plugin.listModels()) {
        observed.push(store.observe(model, plugin.id));
      }
    } catch {
      // One unavailable provider must not block observations from the others.
    }
  }
  return observed;
}

export function getEnrichedModelsCatalog(
  store: ModelPassportStore = getGlobalModelPassportStore()
): EnrichedModelCatalogItem[] {
  const modelMap = new Map<string, EnrichedModelCatalogItem>();

  // 1. Seed with canonical free models whose provider plugin is not explicitly disabled
  for (const m of CANONICAL_FREE_MODELS) {
    const isExplicitlyDisabled =
      globalPluginRegistry.has(m.providerId) && !globalPluginRegistry.isEnabled(m.providerId);
    if (!isExplicitlyDisabled) {
      modelMap.set(m.id, { ...m });
    }
  }

  // 2. Discover additional models from registered plugins
  const plugins = globalPluginRegistry.getEnabled();
  for (const plugin of plugins) {
    if (plugin.id === 'lattice') continue;
    const pModels = (plugin as any).cachedModels || [];
    for (const m of pModels) {
      if (!modelMap.has(m.id)) {
        const isFree = m.isFree || m.id.includes(':free') || m.id.includes('free');
        const badges: ModelBadge[] = [];
        if (isFree) badges.push({ text: 'Free', color: 'emerald' });
        if (m.contextWindow >= 1_000_000) badges.push({ text: '1M Context', color: 'emerald' });
        if (m.supportsThinking) badges.push({ text: 'Reasoning', color: 'amber' });
        if (m.tags?.includes('vision')) badges.push({ text: 'Vision', color: 'cyan' });
        if (m.tags?.includes('fast')) badges.push({ text: 'Fast', color: 'coral' });

        modelMap.set(m.id, {
          id: m.id,
          name: m.name || m.id,
          providerId: m.providerId || plugin.id,
          ownedBy: m.ownedBy || plugin.id,
          ...(m.contextWindow !== undefined
            ? { contextWindow: m.contextWindow, contextWindowFormatted: formatContextWindow(m.contextWindow) }
            : {}),
          ...(m.maxOutputTokens !== undefined
            ? { maxOutputTokens: m.maxOutputTokens, maxOutputTokensFormatted: formatOutputTokens(m.maxOutputTokens) }
            : {}),
          supportsThinking: m.supportsThinking,
          supportsTools: m.supportsTools,
          supportsStreaming: m.supportsStreaming,
          isFree,
          tags: m.tags || ['General'],
          badges,
        });
      }
    }
  }

  // 3. Add Virtual Combos from globalComboManager
  const combos = globalComboManager.listAsModels();
  for (const c of combos) {
    if (!modelMap.has(c.id)) {
      modelMap.set(c.id, {
        id: c.id,
        name: c.name || c.id,
        providerId: 'lattice',
        ownedBy: 'lattice',
        contextWindow: c.contextWindow || 200_000,
        contextWindowFormatted: formatContextWindow(c.contextWindow || 200_000),
        maxOutputTokens: c.maxOutputTokens || 8_192,
        maxOutputTokensFormatted: formatOutputTokens(c.maxOutputTokens || 8_192),
        supportsThinking: !!c.supportsThinking,
        supportsTools: !!c.supportsTools,
        supportsStreaming: true,
        isFree: !!c.isFree,
        tags: c.tags || ['Virtual Combo'],
        badges: [
          { text: 'Virtual Combo', color: 'zinc' },
          { text: c.isFree ? 'Free ($0)' : 'Paid Upstream', color: c.isFree ? 'emerald' : 'amber' },
        ],
      });
    }
  }

  for (const item of modelMap.values()) {
    if (item.providerId === 'lattice') {
      // A combo is usable only when at least one of its targets is configured.
      const combo = globalComboManager.getCombo(item.id);
      const targets = combo?.targets ?? [];
      const usable = targets.some((target) => isProviderConfigured(resolveTargetProviderId(target)).available);
      item.available = usable;
      item.unavailableReason = usable ? undefined : 'No configured provider in this combo';
    } else {
      const status = isProviderConfigured(item.providerId);
      item.available = status.available;
      item.unavailableReason = status.reason;
    }
    const passport = store.get(item.id);
    if (!passport || !verifyPassport(passport)) {
      item.verificationStatus = 'unverified';
      continue;
    }
    const sources: Record<string, PassportEvidenceSource> = {};
    for (const [name, claim] of Object.entries(passport.claims)) {
      if (claim) sources[name] = claim.source;
    }
    item.passportDigest = passport.digest;
    item.claimSources = sources;
    if (passport.claims.contextWindow) {
      item.contextWindow = passport.claims.contextWindow.value;
      item.contextWindowFormatted = formatContextWindow(passport.claims.contextWindow.value);
    }
    if (passport.claims.maxOutputTokens) {
      item.maxOutputTokens = passport.claims.maxOutputTokens.value;
      item.maxOutputTokensFormatted = formatOutputTokens(passport.claims.maxOutputTokens.value);
    }
    if (passport.claims.supportsThinking) {
      item.supportsThinking = passport.claims.supportsThinking.value;
    }
    if (passport.claims.supportsTools) item.supportsTools = passport.claims.supportsTools.value;
    if (passport.claims.supportsStreaming) {
      item.supportsStreaming = passport.claims.supportsStreaming.value;
    }
    if (passport.claims.isFree) item.isFree = passport.claims.isFree.value;
    item.verificationStatus = passport.availability?.source
      ?? Object.values(sources)[0]
      ?? 'unverified';
  }

  return Array.from(modelMap.values());
}

export async function probeModel(
  modelId: string,
  prompt = 'Ping',
  store: ModelPassportStore = getGlobalModelPassportStore(),
  timeoutMs = 30_000
): Promise<{
  success: boolean;
  model: string;
  providerId: string;
  healthy: boolean;
  latencyMs: number;
  sampleResponse: string;
  timestamp: number;
  error?: string;
}> {
  const startTime = Date.now();
  const providerId = resolveTargetProviderId(modelId);
  const plugin = globalPluginRegistry.get(providerId);

  if (!plugin || !globalPluginRegistry.isEnabled(providerId)) {
    return {
      success: false,
      model: modelId,
      providerId,
      healthy: false,
      latencyMs: 0,
      sampleResponse: '',
      error: 'Model not found or provider disabled',
      timestamp: Date.now(),
    };
  }

  try {
    const descriptors = await plugin.listModels();
    const descriptor = descriptors.find((model) => model.id === modelId);
    if (!descriptor) {
      return {
        success: false,
        model: modelId,
        providerId,
        healthy: false,
        latencyMs: 0,
        sampleResponse: '',
        error: 'Model not found or provider disabled',
        timestamp: Date.now(),
      };
    }

    store.observe(descriptor, providerId);
    const response = await withRequestDeadline(
      plugin.execute({
        id: `probe_${crypto.randomUUID()}`,
        clientDialect: 'openai-chat',
        model: modelId,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 1,
        stream: false,
      }),
      timeoutMs,
      `Model probe ${modelId}`
    );
    const latencyMs = Math.max(1, Date.now() - startTime);
    store.recordAvailability(modelId, {
      healthy: true,
      latencyMs,
      evidence: 'explicit basic probe',
    });
    const sampleResponse = response.content
      .filter((part) => part.type === 'text')
      .map((part) => part.type === 'text' ? part.text : '')
      .join('')
      .slice(0, 200);
    return {
      success: true,
      model: modelId,
      providerId,
      healthy: true,
      latencyMs,
      sampleResponse,
      timestamp: Date.now(),
    };
  } catch {
    const latencyMs = Math.max(1, Date.now() - startTime);
    if (store.get(modelId)) {
      store.recordAvailability(modelId, {
        healthy: false,
        latencyMs,
        evidence: 'explicit basic probe',
        error: 'Model probe failed',
      });
    }
    return {
      success: false,
      model: modelId,
      providerId,
      healthy: false,
      latencyMs,
      sampleResponse: '',
      error: 'Model probe failed',
      timestamp: Date.now(),
    };
  }
}
