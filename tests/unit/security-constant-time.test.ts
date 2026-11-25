import { describe, expect, test } from 'bun:test';
import { constantTimeEqual } from '../../src/core/auth-tokens';

describe('SEC-07: constant-time token comparison', () => {
  test('compares tokens correctly for equal, unequal and different-length inputs', () => {
    expect(constantTimeEqual('same-token', 'same-token')).toBe(true);
    expect(constantTimeEqual('same-token', 'other-token')).toBe(false);
    expect(constantTimeEqual('short', 'a-much-longer-token')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });
});
