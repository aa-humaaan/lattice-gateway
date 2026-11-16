import type { ModelDescriptor } from '../core/types/plugin';
import { logger } from '../utils/logger';

export interface VirtualCombo {
  id: string;               // e.g. "lattice/code-flagship"
  name: string;             // Display name
  targets: string[];        // Array of provider model IDs in priority order
  description?: string;
  useProxies?: boolean;
  createdAt: number;
}

export class ComboManager {
  private combos = new Map<string, VirtualCombo>();

  constructor() {
    // 1M Context Window Free Tier Combo
    this.createCombo({
      id: 'lattice/1m-free',
      name: 'Lattice 1M Context Free Tier ($0 Auto-Failover)',
      targets: [
        'kilo/nvidia/nemotron-3.5-super-vl:free',
        'kilo/particle-ai/particle-1:free',
        'kilo/baidu/ernie-5.5-flash-preview:free',
        'kilo/nvidia/nemotron-3.5-lightning:free',
        'kilo/inclusionai/ling-3.2-flash:free',
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

    this.createCombo({
      id: 'lattice/fast-free',
      name: 'Lattice Fast Free 0$ Tier',
      targets: [
        'kilo/nvidia/nemotron-3.5-lightning:free',
        'kilo/code-fast:free',
        'kilo/kilo-auto/free',
        'kilo/deepseek-r1:free',
        'big-pickle',
        'mimo-v2.6-flash-free',
      ],
      description: 'High-speed 0$ cost inference aggregator with automatic failover',
      createdAt: Date.now(),
    });
  }

  createCombo(combo: VirtualCombo): void {
    this.combos.set(combo.id, combo);
    logger.info(`[ComboManager] Registered combo: ${combo.id} -> [${combo.targets.join(', ')}]`);
  }

  getCombo(id: string): VirtualCombo | undefined {
    return this.combos.get(id);
  }

  deleteCombo(id: string): boolean {
    return this.combos.delete(id);
  }

  listCombos(): VirtualCombo[] {
    return Array.from(this.combos.values());
  }

  isCombo(modelId: string): boolean {
    return this.combos.has(modelId);
  }

  listAsModels(): ModelDescriptor[] {
    return this.listCombos().map((c) => ({
      id: c.id,
      name: c.name,
      providerId: 'lattice',
      ownedBy: 'lattice-gateway',
      created: Math.floor(c.createdAt / 1000),
      contextWindow: c.id.includes('1m') ? 1048576 : 200000,
      supportsThinking: true,
      supportsTools: true,
      supportsStreaming: true,
      isFree: c.id.includes('free'),
      tags: ['combo', 'failover', 'virtual'],
    }));
  }
}

export const globalComboManager = new ComboManager();
