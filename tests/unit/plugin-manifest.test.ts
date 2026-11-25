import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer } from '../../src/core/server';
import { PluginRegistry } from '../../src/plugins/registry';
import {
  initializeFromManifest,
  initializePlugins,
  shutdownFromManifest,
  shutdownPlugins,
} from '../../src/core/plugin-lifecycle';

const throwawayDir = join(import.meta.dir, '..', 'fixtures', 'throwaway-provider');

describe('P2-3 manifest-driven providers', () => {
  test('a manifest plus adapter routes requests with no core edits', async () => {
    process.env.THROWAWAY_API_KEY = 'manifest-key';
    try {
      const registry = new PluginRegistry();
      const plugins = await registry.loadManifestsFrom(throwawayDir);
      expect(plugins.map((plugin) => plugin.id)).toEqual(['throwaway']);

      const app = createServer({ gatewayToken: 'gateway-secret' }, registry.getAll());
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer gateway-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'throwaway/echo', messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.choices[0].message.content).toBe('echo:hi');
    } finally {
      delete process.env.THROWAWAY_API_KEY;
    }
  });

  test('manifest metadata drives model resolution and capabilities', async () => {
    process.env.THROWAWAY_API_KEY = 'manifest-key';
    try {
      const registry = new PluginRegistry();
      await registry.loadManifestsFrom(throwawayDir);
      const plugin = await registry.resolvePluginForModel('throwaway/echo');
      expect(plugin?.id).toBe('throwaway');
      expect(registry.getManifest('throwaway')?.capabilities?.responseFormat).toBeTrue();
      expect(registry.getManifest('throwaway')?.displayName).toBe('Throwaway Test Provider');
    } finally {
      delete process.env.THROWAWAY_API_KEY;
    }
  });

  test('a missing required config field fails closed', async () => {
    const saved = process.env.THROWAWAY_API_KEY;
    delete process.env.THROWAWAY_API_KEY;
    try {
      const registry = new PluginRegistry();
      await expect(registry.loadManifestsFrom(throwawayDir)).rejects.toThrow(/THROWAWAY_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.THROWAWAY_API_KEY = saved;
    }
  });

  test('initialize and shutdown hooks run once and are observable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-lifecycle-'));
    process.env.THROWAWAY_API_KEY = 'lifecycle-key';
    process.env.THROWAWAY_LIFECYCLE_LOG = join(dir, 'lifecycle.log');
    try {
      const registry = new PluginRegistry();
      const plugins = await registry.loadManifestsFrom(throwawayDir);
      await initializePlugins(plugins, { dataDir: dir, logger: console });
      await shutdownPlugins(plugins);
      expect(readFileSync(process.env.THROWAWAY_LIFECYCLE_LOG!, 'utf8').trim().split('\n'))
        .toEqual(['initialize:lifecycle-key', 'shutdown']);
    } finally {
      delete process.env.THROWAWAY_API_KEY;
      delete process.env.THROWAWAY_LIFECYCLE_LOG;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('manifest lifecycle hooks are loaded and exposed by the registry', async () => {
    process.env.THROWAWAY_API_KEY = 'manifest-key';
    try {
      const registry = new PluginRegistry();
      await registry.loadManifestsFrom(throwawayDir);
      expect(registry.getManifest('throwaway')?.lifecycle?.hooks).toEqual(['initialize', 'shutdown']);
      expect(registry.getLifecycleHooks('throwaway')).toEqual(['initialize', 'shutdown']);
    } finally {
      delete process.env.THROWAWAY_API_KEY;
    }
  });

  test('only manifest-declared hooks run from the registry lifecycle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-manifest-hooks-'));
    process.env.THROWAWAY_API_KEY = 'lifecycle-key';
    process.env.THROWAWAY_LIFECYCLE_LOG = join(dir, 'lifecycle.log');
    try {
      const registry = new PluginRegistry();
      await registry.loadManifestsFrom(join(throwawayDir, 'shutdown-only'));
      expect(registry.getLifecycleHooks('throwaway')).toEqual(['shutdown']);
      await initializeFromManifest(registry, { dataDir: dir, logger: console });
      expect(existsSync(process.env.THROWAWAY_LIFECYCLE_LOG!)).toBeFalse();
      await shutdownFromManifest(registry);
      expect(readFileSync(process.env.THROWAWAY_LIFECYCLE_LOG!, 'utf8').trim()).toBe('shutdown');
    } finally {
      delete process.env.THROWAWAY_API_KEY;
      delete process.env.THROWAWAY_LIFECYCLE_LOG;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // SOURCE GUARD: entrypoints are spawned as scripts by the CLI tests, so their
  // lifecycle wiring cannot be observed through an in-process import.
  test('SOURCE GUARD: both entrypoints load manifests and run manifest-declared hooks', () => {
    for (const file of ['src/index.ts', 'bin/lattice.ts']) {
      const source = readFileSync(file, 'utf8');
      expect(source).toContain('loadManifestsFrom');
      expect(source).toContain('initializeFromManifest(');
      expect(source).toContain('shutdownFromManifest(');
    }
  });

  test('the migrated OpenCode provider loads from its manifest', async () => {
    const registry = new PluginRegistry();
    await registry.loadManifestsFrom(join(process.cwd(), 'src', 'plugins', 'manifests'));
    expect(registry.has('opencode')).toBeTrue();
    expect(registry.getManifest('opencode')?.displayName).toBe('OpenCode Zen Provider Plugin');
    expect(registry.getManifest('opencode')?.modelPrefixes).toContain('opencode/');
  });
});
