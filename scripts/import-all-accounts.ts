import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';

const STORE_PATH = path.join(process.cwd(), 'data', 'lattice-store.json');

interface StoredAccount {
  id: string;
  providerId: string;
  authType: string;
  status: 'active' | 'cooldown' | 'disabled';
  credentials: Record<string, any>;
  errorCount: number;
  lastUsed?: number;
  cooldownUntil?: number;
  createdAt: number;
  updatedAt: number;
}

interface LatticeStore {
  accounts: StoredAccount[];
  combos: any[];
  proxies: any[];
  updatedAt: number;
}

function loadStore(): LatticeStore {
  if (fs.existsSync(STORE_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
    } catch {
      // fallback
    }
  }
  return { accounts: [], combos: [], proxies: [], updatedAt: Date.now() };
}

function saveStore(store: LatticeStore) {
  store.updatedAt = Date.now();
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf-8');
  console.log(`[Import] Saved ${store.accounts.length} accounts to ${STORE_PATH}`);
}

async function main() {
  const store = loadStore();
  const accountMap = new Map<string, StoredAccount>();

  // Keep existing
  for (const acc of store.accounts) {
    accountMap.set(acc.id, acc);
  }

  // 1. Import from 9router (Kilo & Nous)
  const nineRouterDbPath = 'C:/Users/adity/AppData/Roaming/9router/db/data.sqlite';
  if (fs.existsSync(nineRouterDbPath)) {
    try {
      const db = new Database(nineRouterDbPath);
      const conns = db.query("SELECT * FROM providerConnections WHERE isActive = 1").all() as any[];
      for (const conn of conns) {
        let connData: any = {};
        try {
          connData = JSON.parse(conn.data);
        } catch {}

        if (conn.provider === 'kilocode' && connData.accessToken) {
          const accId = 'acc_kilo_thelazzycoders';
          accountMap.set(accId, {
            id: accId,
            providerId: 'kilo',
            authType: 'oauth',
            status: 'active',
            credentials: {
              accessToken: connData.accessToken,
              email: conn.email || 'thelazzycoders@gmail.com',
              baseUrl: 'https://ai-gateway.kilo.ai/api/v1',
            },
            errorCount: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
          console.log('[Import] Ingested Kilo Code account:', conn.email);
        }

        if (conn.provider === 'nous' && connData.accessToken) {
          const accId = 'acc_nous_portal';
          accountMap.set(accId, {
            id: accId,
            providerId: 'nous',
            authType: 'oauth',
            status: 'active',
            credentials: {
              accessToken: connData.accessToken,
              baseUrl: connData.providerSpecificData?.inferenceBaseUrl || 'https://inference-api.nousresearch.com/v1',
            },
            errorCount: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
          console.log('[Import] Ingested Nous Research account');
        }
      }
    } catch (e) {
      console.error('[Import] Failed reading 9router DB:', e);
    }
  }

  // 2. Import from Cline Proxy (.cline-accounts.json)
  const clineAccountsPath = 'C:/Users/adity/Videos/cline-proxy-main/cline-proxy-main/data/.cline-accounts.json';
  if (fs.existsSync(clineAccountsPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(clineAccountsPath, 'utf-8'));
      if (Array.isArray(raw.accounts)) {
        for (const [idx, acc] of raw.accounts.entries()) {
          const accId = `acc_cline_${idx + 1}_${acc.accountId || idx}`;
          accountMap.set(accId, {
            id: accId,
            providerId: 'cline',
            authType: 'oauth',
            status: 'active',
            credentials: {
              refreshToken: acc.refreshToken,
              email: acc.email,
              accountId: acc.accountId,
            },
            errorCount: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
          console.log(`[Import] Ingested Cline account ${idx + 1}:`, acc.email);
        }
      }
    } catch (e) {
      console.error('[Import] Failed reading Cline accounts:', e);
    }
  }

  // 3. Import from FreeDeepseekAPI (account-2.json)
  const deepseekAccPath = 'C:/Users/adity/Music/deepseek-v4/FreeDeepseekAPI/accounts/account-2.json';
  if (fs.existsSync(deepseekAccPath)) {
    try {
      const ds = JSON.parse(fs.readFileSync(deepseekAccPath, 'utf-8'));
      const accId = 'acc_deepseek_chrome_pool';
      accountMap.set(accId, {
        id: accId,
        providerId: 'deepseek',
        authType: 'cookie_pool',
        status: 'active',
        credentials: {
          userToken: ds.token,
          cookie: ds.cookie,
          wasmUrl: ds.wasmUrl,
          baseUrl: 'https://chat.deepseek.com/api/v0',
        },
        errorCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      console.log('[Import] Ingested DeepSeek Chrome Session Account');
    } catch (e) {
      console.error('[Import] Failed reading DeepSeek account:', e);
    }
  }

  // 4. Register OpenCode Zen keyless / anonymous account
  const opencodeAccId = 'acc_opencode_zen_free';
  accountMap.set(opencodeAccId, {
    id: opencodeAccId,
    providerId: 'opencode',
    authType: 'anonymous',
    status: 'active',
    credentials: {
      baseUrl: 'https://opencode.ai/inference/openai/v1',
    },
    errorCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  console.log('[Import] Registered OpenCode Zen Anonymous Free Account');

  store.accounts = Array.from(accountMap.values());
  saveStore(store);
}

main().catch(console.error);
