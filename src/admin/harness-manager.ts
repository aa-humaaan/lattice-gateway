import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

export interface HarnessInfo {
  id: string;
  name: string;
  category: string;
  protocol: 'openai' | 'anthropic' | 'gemini';
  targetPath: string;
  detected: boolean;
  configured: boolean;
  configSnippet: string;
  description: string;
  recommendedModel: string;
}

export interface SetupResult {
  success: boolean;
  harness: string;
  path: string;
  backupPath?: string;
  message: string;
  error?: string;
}

// Strip single-line and multi-line comments from JSONC
function stripJsonComments(jsonc: string): string {
  return jsonc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function safeReadJson(filePath: string): any {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(stripJsonComments(raw));
  } catch {
    return null;
  }
}

function safeWriteJson(targetPath: string, data: any): { backupPath?: string } {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let backupPath: string | undefined;
  if (fs.existsSync(targetPath)) {
    backupPath = `${targetPath}.bak.${Date.now()}`;
    try {
      fs.copyFileSync(targetPath, backupPath);
    } catch {}
  }

  const tmpPath = `${targetPath}.tmp.${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, targetPath);

  return { backupPath };
}

// Platform path resolvers
function getRoamingAppData(): string {
  if (process.platform === 'win32') {
    return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  return path.join(os.homedir(), '.config');
}

export function getHarnessDefinitions(): Record<string, {
  name: string;
  category: string;
  protocol: 'openai' | 'anthropic' | 'gemini';
  getPath: () => string;
  recommendedModel: string;
  description: string;
  getSnippet: (targetPath: string) => string;
  configure: (targetPath: string) => { backupPath?: string; message: string };
}> {
  const home = os.homedir();
  const appData = getRoamingAppData();

  return {
    opencode: {
      name: 'OpenCode',
      category: 'CLI & Coding Agent',
      protocol: 'openai',
      recommendedModel: 'lattice/1m-free',
      description: 'Zero-auth Zen models and 1M Kilo models auto-wired into OpenCode config.',
      getPath: () => path.join(home, '.config', 'opencode', 'opencode.json'),
      getSnippet: (targetPath: string) => JSON.stringify({
        "$schema": "https://opencode.ai/config.json",
        "provider": {
          "lattice": {
            "npm": "@ai-sdk/openai-compatible",
            "name": "Lattice Gateway",
            "options": {
              "baseURL": "http://127.0.0.1:4000/v1",
              "apiKey": "sk-lattice-master"
            },
            "models": {
              "lattice/1m-free": {
                "name": "Lattice 1M Free ($0)",
                "attachment": true,
                "reasoning": true,
                "tool_call": true,
                "limit": { "context": 1048576, "output": 8192 }
              },
              "lattice/code-flagship": {
                "name": "Lattice Code Flagship",
                "attachment": true,
                "reasoning": true,
                "tool_call": true,
                "limit": { "context": 200000, "output": 8192 }
              }
            }
          }
        },
        "model": "lattice/lattice/1m-free"
      }, null, 2),
      configure: (targetPath: string) => {
        let current = safeReadJson(targetPath) || {
          $schema: "https://opencode.ai/config.json",
          provider: {}
        };
        if (!current.provider) current.provider = {};
        current.provider.lattice = {
          npm: "@ai-sdk/openai-compatible",
          name: "Lattice Gateway",
          options: {
            baseURL: "http://127.0.0.1:4000/v1",
            apiKey: "sk-lattice-master"
          },
          models: {
            "lattice/1m-free": {
              name: "Lattice 1M Free ($0)",
              attachment: true,
              reasoning: true,
              tool_call: true,
              limit: { context: 1048576, output: 8192 }
            },
            "lattice/code-flagship": {
              name: "Lattice Code Flagship",
              attachment: true,
              reasoning: true,
              tool_call: true,
              limit: { context: 200000, output: 8192 }
            }
          }
        };
        if (!current.model) {
          current.model = "lattice/lattice/1m-free";
        }
        const { backupPath } = safeWriteJson(targetPath, current);
        return { backupPath, message: `Merged Lattice Gateway provider into OpenCode config at ${targetPath}` };
      }
    },

    kilo: {
      name: 'Kilo Code',
      category: 'VS Code & CLI Extension',
      protocol: 'openai',
      recommendedModel: 'lattice/1m-free',
      description: 'Wires local 127.0.0.1:4000 gateway into Kilo Code configuration.',
      getPath: () => path.join(home, '.config', 'kilo', 'kilo.jsonc'),
      getSnippet: (targetPath: string) => JSON.stringify({
        "$schema": "https://app.kilo.ai/config.json",
        "permission": { "*": { "*": "allow" } },
        "model": "lattice/1m-free",
        "provider": {
          "lattice": {
            "npm": "@ai-sdk/openai-compatible",
            "name": "Lattice Gateway",
            "options": {
              "baseURL": "http://127.0.0.1:4000/v1",
              "apiKey": "sk-lattice-master"
            }
          }
        }
      }, null, 2),
      configure: (targetPath: string) => {
        let current = safeReadJson(targetPath) || {
          $schema: "https://app.kilo.ai/config.json",
          permission: { "*": { "*": "allow" } }
        };
        if (!current.provider) current.provider = {};
        current.provider.lattice = {
          npm: "@ai-sdk/openai-compatible",
          name: "Lattice Gateway",
          options: {
            baseURL: "http://127.0.0.1:4000/v1",
            apiKey: "sk-lattice-master"
          }
        };
        current.model = "lattice/1m-free";
        const { backupPath } = safeWriteJson(targetPath, current);
        return { backupPath, message: `Configured Kilo Code pointing to http://127.0.0.1:4000/v1 at ${targetPath}` };
      }
    },

    roo: {
      name: 'Roo Code',
      category: 'VS Code Extension',
      protocol: 'openai',
      recommendedModel: 'lattice/1m-free',
      description: 'Configures Roo Code extension in VS Code settings to use Lattice Gateway.',
      getPath: () => path.join(appData, 'Code', 'User', 'settings.json'),
      getSnippet: (targetPath: string) => JSON.stringify({
        "roo-cline.apiProvider": "openai-compatible",
        "roo-cline.openAiBaseUrl": "http://127.0.0.1:4000/v1",
        "roo-cline.openAiApiKey": "sk-lattice-master",
        "roo-cline.openAiModelId": "lattice/1m-free",
        "roo-cline.openAiCustomModelInfo": {
          "maxTokens": 8192,
          "contextWindow": 1000000,
          "supportsImages": true,
          "supportsComputerUse": false,
          "supportsPromptCache": true
        }
      }, null, 2),
      configure: (targetPath: string) => {
        let current = safeReadJson(targetPath) || {};
        current["roo-cline.apiProvider"] = "openai-compatible";
        current["roo-cline.openAiBaseUrl"] = "http://127.0.0.1:4000/v1";
        current["roo-cline.openAiApiKey"] = "sk-lattice-master";
        current["roo-cline.openAiModelId"] = "lattice/1m-free";
        current["roo-cline.openAiCustomModelInfo"] = {
          maxTokens: 8192,
          contextWindow: 1000000,
          supportsImages: true,
          supportsComputerUse: false,
          supportsPromptCache: true
        };
        const { backupPath } = safeWriteJson(targetPath, current);
        return { backupPath, message: `Configured Roo Code in VS Code settings at ${targetPath}` };
      }
    },

    claude: {
      name: 'Claude Code',
      category: 'Terminal Agent',
      protocol: 'anthropic',
      recommendedModel: 'lattice/1m-free',
      description: 'Configures native Anthropic Messages API routing on http://127.0.0.1:4000 with 1M tokens.',
      getPath: () => path.join(home, '.claude', 'settings.json'),
      getSnippet: (targetPath: string) => JSON.stringify({
        "env": {
          "ANTHROPIC_BASE_URL": "http://127.0.0.1:4000",
          "ANTHROPIC_AUTH_TOKEN": "sk-lattice-master",
          "ANTHROPIC_API_KEY": "sk-lattice-master",
          "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1",
          "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "1000000"
        },
        "model": "lattice/1m-free",
        "modelOverrides": {
          "claude-opus-4-6": "lattice/code-flagship",
          "claude-sonnet-4-6": "lattice/1m-free"
        }
      }, null, 2),
      configure: (targetPath: string) => {
        let current = safeReadJson(targetPath) || {};
        if (!current.env) current.env = {};
        current.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4000";
        current.env.ANTHROPIC_AUTH_TOKEN = "sk-lattice-master";
        current.env.ANTHROPIC_API_KEY = "sk-lattice-master";
        current.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1";
        current.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = "1000000";
        current.model = "lattice/1m-free";
        if (!current.modelOverrides) current.modelOverrides = {};
        current.modelOverrides["claude-opus-4-6"] = "lattice/code-flagship";
        current.modelOverrides["claude-sonnet-4-6"] = "lattice/1m-free";

        const { backupPath } = safeWriteJson(targetPath, current);
        return { backupPath, message: `Configured Claude Code pointing to http://127.0.0.1:4000 at ${targetPath}` };
      }
    },

    gemini: {
      name: 'Gemini CLI',
      category: 'Google CLI Tool',
      protocol: 'gemini',
      recommendedModel: 'lattice/1m-free',
      description: 'Sets gateway authentication and endpoint base in Gemini CLI settings.',
      getPath: () => path.join(home, '.gemini', 'settings.json'),
      getSnippet: (targetPath: string) => JSON.stringify({
        "security": {
          "auth": {
            "selectedType": "gateway"
          }
        },
        "env": {
          "GOOGLE_GEMINI_BASE_URL": "http://127.0.0.1:4000",
          "GEMINI_API_KEY": "sk-lattice-master",
          "GEMINI_MODEL": "lattice/1m-free"
        }
      }, null, 2),
      configure: (targetPath: string) => {
        let current = safeReadJson(targetPath) || {};
        if (!current.security) current.security = {};
        if (!current.security.auth) current.security.auth = {};
        current.security.auth.selectedType = "gateway";
        if (!current.env) current.env = {};
        current.env.GOOGLE_GEMINI_BASE_URL = "http://127.0.0.1:4000";
        current.env.GEMINI_API_KEY = "sk-lattice-master";
        current.env.GEMINI_MODEL = "lattice/1m-free";

        const { backupPath } = safeWriteJson(targetPath, current);
        return { backupPath, message: `Configured Gemini CLI gateway mode at ${targetPath}` };
      }
    },

    crush: {
      name: 'Crush CLI',
      category: 'Charm Terminal Agent',
      protocol: 'openai',
      recommendedModel: 'lattice/1m-free',
      description: 'Charmbracelet terminal assistant config pointing to Lattice OpenAI dialect.',
      getPath: () => path.join(home, '.config', 'crush', 'crush.json'),
      getSnippet: (targetPath: string) => JSON.stringify({
        "$schema": "https://charm.land/crush.json",
        "providers": {
          "lattice": {
            "type": "openai-compat",
            "base_url": "http://127.0.0.1:4000/v1",
            "api_key": "sk-lattice-master",
            "models": [
              { "id": "lattice/1m-free", "name": "Lattice 1M Free ($0)", "context_window": 1000000 },
              { "id": "lattice/code-flagship", "name": "Lattice Code Flagship", "context_window": 200000 }
            ]
          }
        }
      }, null, 2),
      configure: (targetPath: string) => {
        let current = safeReadJson(targetPath) || {
          $schema: "https://charm.land/crush.json",
          providers: {}
        };
        if (!current.providers) current.providers = {};
        current.providers.lattice = {
          type: "openai-compat",
          base_url: "http://127.0.0.1:4000/v1",
          api_key: "sk-lattice-master",
          models: [
            { id: "lattice/1m-free", name: "Lattice 1M Free ($0)", context_window: 1000000 },
            { id: "lattice/code-flagship", name: "Lattice Code Flagship", context_window: 200000 }
          ]
        };

        const { backupPath } = safeWriteJson(targetPath, current);
        return { backupPath, message: `Configured Crush CLI provider at ${targetPath}` };
      }
    },

    cursor: {
      name: 'Cursor',
      category: 'AI Code Editor',
      protocol: 'openai',
      recommendedModel: 'lattice/1m-free',
      description: 'Wires Cursor editor settings and workspace rules to Lattice Gateway.',
      getPath: () => path.join(appData, 'Cursor', 'User', 'settings.json'),
      getSnippet: (targetPath: string) => JSON.stringify({
        "cursor.openAI.baseUrl": "http://127.0.0.1:4000/v1",
        "cursor.openAI.apiKey": "sk-lattice-master",
        "cursor.models": [
          "lattice/1m-free",
          "lattice/code-flagship"
        ]
      }, null, 2),
      configure: (targetPath: string) => {
        let current = safeReadJson(targetPath) || {};
        current["cursor.openAI.baseUrl"] = "http://127.0.0.1:4000/v1";
        current["cursor.openAI.apiKey"] = "sk-lattice-master";
        current["cursor.models"] = ["lattice/1m-free", "lattice/code-flagship"];

        const { backupPath } = safeWriteJson(targetPath, current);
        return { backupPath, message: `Configured Cursor editor settings at ${targetPath}` };
      }
    }
  };
}

export function detectAllHarnesses(): HarnessInfo[] {
  const defs = getHarnessDefinitions();
  const results: HarnessInfo[] = [];

  for (const [id, def] of Object.entries(defs)) {
    const targetPath = def.getPath();
    const exists = fs.existsSync(targetPath);
    let configured = false;

    if (exists) {
      try {
        const content = fs.readFileSync(targetPath, 'utf-8');
        configured = content.includes('127.0.0.1:4000') || content.includes('http://127.0.0.1:4000');
      } catch {}
    }

    results.push({
      id,
      name: def.name,
      category: def.category,
      protocol: def.protocol,
      targetPath,
      detected: exists,
      configured,
      configSnippet: def.getSnippet(targetPath),
      description: def.description,
      recommendedModel: def.recommendedModel,
    });
  }

  return results;
}

export function configureHarness(harnessId: string): SetupResult {
  const defs = getHarnessDefinitions();
  const def = defs[harnessId];
  if (!def) {
    return {
      success: false,
      harness: harnessId,
      path: '',
      message: `Unknown harness ID: ${harnessId}`,
      error: `Unknown harness ID: ${harnessId}`
    };
  }

  try {
    const targetPath = def.getPath();
    const res = def.configure(targetPath);
    return {
      success: true,
      harness: harnessId,
      path: targetPath,
      backupPath: res.backupPath,
      message: res.message
    };
  } catch (err: any) {
    return {
      success: false,
      harness: harnessId,
      path: def.getPath(),
      message: `Failed to configure ${harnessId}: ${err.message}`,
      error: err.message
    };
  }
}
