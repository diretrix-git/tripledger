import { describe, expect, it } from 'vitest';
import { formatPaisaToNPR, nprToPaisa } from '@tripledger/shared';

describe('TripLedger Client Shared Currency Integration', () => {
  it('consumes @tripledger/shared paisa formatting accurately', () => {
    const paisa = nprToPaisa('1500.50');
    expect(paisa).toBe(150050);
    expect(formatPaisaToNPR(paisa)).toBe('NPR 1,500.50');
  });
});
