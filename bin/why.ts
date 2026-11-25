#!/usr/bin/env bun
import { createLedger } from '../src/core/request-ledger';
import { buildReceipt, findLedgerEvent } from '../src/core/receipt';

const id = process.argv[2];

if (!id) {
  console.error('Usage: bun run why <request-id-or-prefix>');
  process.exit(2);
}

const ledger = createLedger(process.env.LATTICE_LEDGER_PATH || 'data/request-ledger.ndjson');
const event = findLedgerEvent(ledger, id);

if (!event) {
  console.error(`No ledger event found for "${id}"`);
  process.exit(1);
}

for (const line of buildReceipt(event).lines) console.log(line);
