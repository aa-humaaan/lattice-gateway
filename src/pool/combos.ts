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
    // Default Flagship Combos out of the box
    this.createCombo({
      id: 'lattice/code-flagship',
      name: 'Lattice Code Flagship (Auto-Failover)',
      targets: [
        'kilo/code-fast:free',
        'nous/hermes-3-llama3',
        'cline/sonnet-agent',
        'deepseek/deepseek-reasoner',
      ],
      description: 'Zero-drop multi-provider coding engine with automatic 429 fallback',
      createdAt: Date.now(),
    });

    this.createCombo({
      id: 'lattice/fast-free',
      name: 'Lattice Fast Free 0$ Tier',
      targets: [
        'kilo/code-fast:free',
        'big-pickle',
        'mimo-v2.6-flash-free',
      ],
      description: 'High-speed 0$ cost inference aggregator',
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
      contextWindow: 128000,
      supportsThinking: true,
      supportsTools: true,
      supportsStreaming: true,
      isFree: true,
      tags: ['combo', 'failover', 'virtual'],
    }));
  }
}

export const globalComboManager = new ComboManager();
