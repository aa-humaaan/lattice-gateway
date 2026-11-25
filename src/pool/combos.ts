import type { ModelDescriptor } from '../core/types/plugin';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger';

/** Data-only combo policy. See docs/combo-policies.md for the format. */
export interface ComboPolicy {
  version: 1;
  strategy: 'tier-failover';
  tiers: string[];
  maxFailuresPerTier: number;
}

export interface ComboPolicyTarget {
  model: string;
  tier: string;
}

interface ComboPolicyFile {
  id: string;
  name: string;
  description?: string;
  useProxies?: boolean;
  policy: ComboPolicy;
  targets: ComboPolicyTarget[];
  contextWindow?: number;
}

export interface VirtualCombo {
  id: string;               // e.g. "lattice/code-flagship"
  name: string;             // Display name
  targets: string[];        // Array of provider model IDs in priority order
  description?: string;
  useProxies?: boolean;
  createdAt: number;
  policy?: ComboPolicy;
  tiers?: Record<string, string>;   // target model id -> tier
  contextWindow?: number;           // only a verified claim, never name-inferred
}

export const BUILTIN_POLICY_DIR = fileURLToPath(new URL('./combo-policies/', import.meta.url));

export function orderComboTargets(combo: VirtualCombo, pinnedTarget?: string): string[] {
  const targets = [...combo.targets];
  if (combo.policy) {
    const rank = (target: string) => {
      const tier = combo.tiers?.[target];
      const index = tier ? combo.policy!.tiers.indexOf(tier) : -1;
      return index < 0 ? combo.policy!.tiers.length : index;
    };
    targets.sort((a, b) => rank(a) - rank(b));
  }
  if (pinnedTarget && targets.includes(pinnedTarget)) {
    return [pinnedTarget, ...targets.filter((target) => target !== pinnedTarget)];
  }
  return targets;
}

export function comboTargetTier(combo: VirtualCombo, target: string): string | undefined {
  return combo.tiers?.[target];
}

export class ComboManager {
  private combos = new Map<string, VirtualCombo>();

  constructor(policyDir: string = BUILTIN_POLICY_DIR) {
    for (const file of readdirSync(policyDir).filter((name) => name.endsWith('.json')).sort()) {
      const definition = JSON.parse(readFileSync(join(policyDir, file), 'utf8')) as ComboPolicyFile;
      if (!definition.id || !definition.name || !definition.policy || !definition.targets) {
        throw new Error(`Invalid combo policy: ${file}`);
      }
      this.createCombo({
        id: definition.id,
        name: definition.name,
        description: definition.description,
        useProxies: definition.useProxies,
        targets: definition.targets.map((target) => target.model),
        tiers: Object.fromEntries(definition.targets.map((target) => [target.model, target.tier])),
        policy: definition.policy,
        contextWindow: definition.contextWindow,
        createdAt: Date.now(),
      });
    }

    // 1M Context Window Free Tier Combo
    this.createCombo({
      id: 'lattice/1m-free',
      name: 'Lattice 1M Context Free Tier ($0 Auto-Failover)',
      targets: [
        'kilo/particle-ai/particle-1:free',
        'kilo/nvidia/nemotron-3.5-lightning:free',
        'kilo/baidu/ernie-5.5-flash-preview:free',
        'kilo/nvidia/nemotron-3-ultra-550b-a55b:free',
        'kilo/kilo-auto/free',
      ],
      description: 'Zero-cost 1,000,000+ token context window cascade with instant rate-limit failover across top free providers',
      createdAt: Date.now(),
    });

    // Flagship Coding Combos with Zero-Drop Fallback
    this.createCombo({
      id: 'lattice/code-flagship',
      name: 'Lattice Code Flagship (Auto-Failover)',
      targets: [
        'cline/sonnet-agent',
        'kilo/claude-3-7-sonnet',
        'kilo/claude-3-5-sonnet',
        'deepseek/deepseek-chat',
        'nous/qwen/qwen4-max',
        'kilo/nvidia/nemotron-3.5-super-vl:free',
        'kilo/code-fast:free',
      ],
      description: 'Zero-drop multi-provider coding engine with automatic 429 fallback',
      createdAt: Date.now(),
    });
  }

  createCombo(combo: VirtualCombo): void {
    this.combos.set(combo.id, combo);
    logger.info(`[ComboManager] Registered combo: ${combo.id} -> [${combo.targets.join(', ')}]`);
  }

  getCombo(id: string): VirtualCombo | undefined {
    if (!id) return undefined;
    if (this.combos.has(id)) return this.combos.get(id);

    // Normalize redundant prefixes, e.g. "lattice/lattice/1m-free" -> "lattice/1m-free"
    const cleaned = id.replace(/^(lattice\/)+/, 'lattice/');
    if (this.combos.has(cleaned)) return this.combos.get(cleaned);

    // Try prepending "lattice/" if bare, e.g. "1m-free" -> "lattice/1m-free"
    if (!cleaned.startsWith('lattice/') && this.combos.has(`lattice/${cleaned}`)) {
      return this.combos.get(`lattice/${cleaned}`);
    }

    return undefined;
  }

  deleteCombo(id: string): boolean {
    return this.combos.delete(id);
  }

  listCombos(): VirtualCombo[] {
    return Array.from(this.combos.values());
  }

  isCombo(modelId: string): boolean {
    return !!this.getCombo(modelId);
  }

  listAsModels(): ModelDescriptor[] {
    return this.listCombos().map((c) => ({
      id: c.id,
      name: c.name,
      providerId: 'lattice',
      ownedBy: 'lattice-gateway',
      created: Math.floor(c.createdAt / 1000),
      ...(c.contextWindow ? { contextWindow: c.contextWindow } : {}),
      supportsThinking: true,
      supportsTools: true,
      supportsStreaming: true,
      isFree: c.id.includes('free'),
      tags: ['combo', 'failover', 'virtual'],
    }));
  }
}

export const globalComboManager = new ComboManager();
