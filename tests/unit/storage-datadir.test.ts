import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LatticeStorage } from '../../src/pool/storage';

describe('storage data directory', () => {
  test('honors DATA_DIR so isolated runs never touch the live store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-datadir-'));
    const prev = process.env.DATA_DIR;
    process.env.DATA_DIR = dir;
    try {
      new LatticeStorage();
      expect(existsSync(join(dir, 'lattice-store.json'))).toBeTrue();
    } finally {
      if (prev === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('explicit dataDir argument still wins over DATA_DIR', () => {
    const dirA = mkdtempSync(join(tmpdir(), 'lattice-datadir-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'lattice-datadir-b-'));
    const prev = process.env.DATA_DIR;
    process.env.DATA_DIR = dirB;
    try {
      new LatticeStorage(dirA);
      expect(existsSync(join(dirA, 'lattice-store.json'))).toBeTrue();
      expect(existsSync(join(dirB, 'lattice-store.json'))).toBeFalse();
    } finally {
      if (prev === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = prev;
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});
