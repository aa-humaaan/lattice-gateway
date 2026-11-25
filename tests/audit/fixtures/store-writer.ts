import { LatticeStorage } from '../../../src/pool/storage';

// Child process used by ADV-1. It repeatedly performs a full store write so the
// parent can SIGKILL it at an arbitrary point inside writeAtomic().
const storage = new LatticeStorage();
for (;;) {
  console.log('WRITING');
  storage.save();
}
