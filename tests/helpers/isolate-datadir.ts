// Test files must never write to the operator's live credential store.
// globalStorage honors DATA_DIR, so point every test worker at a throwaway dir.
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const dir = mkdtempSync(join(tmpdir(), 'lattice-tests-'));
process.env.DATA_DIR = dir;
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
