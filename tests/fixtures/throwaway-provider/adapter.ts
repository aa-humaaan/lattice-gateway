import { appendFileSync } from 'fs';
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
} from '../../../src/core/types/canonical';
import type { ProviderPlugin } from '../../../src/core/types/plugin';

function echoText(req: CanonicalRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const message = req.messages[i];
    if (message.role !== 'user') continue;
    if (typeof message.content === 'string') return `echo:${message.content}`;
    const text = (message.content as any[]).find((part) => part?.type === 'text')?.text;
    if (text) return `echo:${text}`;
  }
  return 'echo:';
}

/** The whole adapter contract: one factory returning a ProviderPlugin. */
export function createPlugin(config: { apiKey?: string } = {}): ProviderPlugin {
  const logPath = process.env.THROWAWAY_LIFECYCLE_LOG;
  const log = (line: string) => {
    if (logPath) appendFileSync(logPath, `${line}\n`);
  };
  return {
    id: 'throwaway',
    displayName: 'Throwaway Test Provider',
    defaultBaseUrl: 'http://127.0.0.1:9',
    capabilities: { responseFormat: true, samplingFields: true },
    supportedAuthTypes: ['api_key'] as const,
    async listModels() {
      return [{ id: 'throwaway/echo', name: 'Echo' }];
    },
    async execute(req: CanonicalRequest): Promise<CanonicalResponse> {
      return {
        id: 'throwaway_1',
        model: req.model,
        created: 1,
        content: [{ type: 'text', text: echoText(req) }],
        stopReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
    async executeStream(req: CanonicalRequest): Promise<AsyncIterable<CanonicalStreamEvent>> {
      const text = echoText(req);
      async function* stream(): AsyncGenerator<CanonicalStreamEvent> {
        yield { type: 'stream_start', id: 'throwaway_1', model: req.model, created: 1 };
        yield { type: 'text_delta', delta: text };
        yield { type: 'stream_end', stopReason: 'stop' };
      }
      return stream();
    },
    async initialize() {
      log(`initialize:${config.apiKey ?? 'none'}`);
    },
    async shutdown() {
      log('shutdown');
    },
  };
}
