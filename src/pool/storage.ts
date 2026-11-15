import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger';
import { globalAccountPool } from './account-pool';
import { globalComboManager } from './combos';
import { globalProxyPool } from './proxy-pool';

export interface PersistentData {
  accounts: any[];
  combos: any[];
  proxies: any[];
  updatedAt: number;
}

export class LatticeStorage {
  private dataDir: string;
  private filePath: string;

  constructor(dataDir = 'data') {
    this.dataDir = dataDir;
    this.filePath = join(dataDir, 'lattice-store.json');
    this.ensureDir();
  }

  private ensureDir(): void {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }
  }

  load(): void {
    try {
      if (!existsSync(this.filePath)) {
        this.save();
        return;
      }
      const raw = readFileSync(this.filePath, 'utf-8');
      const data: PersistentData = JSON.parse(raw);

      if (Array.isArray(data.accounts)) {
        for (const acc of data.accounts) {
          globalAccountPool.addAccount(acc);
        }
      }
      if (Array.isArray(data.combos)) {
        for (const c of data.combos) {
          globalComboManager.createCombo(c);
        }
      }
      if (Array.isArray(data.proxies)) {
        for (const p of data.proxies) {
          globalProxyPool.addProxy(p.url, p.type);
        }
      }
      logger.info(`[Storage] Loaded state from ${this.filePath}`);
    } catch (err) {
      logger.error(`[Storage] Failed to load ${this.filePath}:`, err);
    }
  }

  save(): void {
    try {
      this.ensureDir();
      const payload: PersistentData = {
        accounts: globalAccountPool.listAccounts(),
        combos: globalComboManager.listCombos(),
        proxies: globalProxyPool.listProxies(),
        updatedAt: Date.now(),
      };
      writeFileSync(this.filePath, JSON.stringify(payload, null, 2), 'utf-8');
    } catch (err) {
      logger.error(`[Storage] Failed to save state to ${this.filePath}:`, err);
    }
  }
}

export const globalStorage = new LatticeStorage();
