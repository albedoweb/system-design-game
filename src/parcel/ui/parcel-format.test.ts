import { describe, expect, it } from 'vitest';

import { PARCEL_LEVEL } from '../level';
import {
  formatSuccessfulMilliseconds,
  operationPassLabel,
} from './parcel-format';

describe('successful-response presentation', () => {
  it('shows a dash instead of 0 ms when there are no successful samples', () => {
    expect(formatSuccessfulMilliseconds(0, 0)).toBe('—');
    expect(formatSuccessfulMilliseconds(0, 1)).toBe('0 ms');
    expect(formatSuccessfulMilliseconds(42, 3)).toBe('42 ms');
  });

  it('never reports a passing latency for an all-error operation', () => {
    const result = operationPassLabel(
      'status',
      0,
      0,
      0,
      PARCEL_LEVEL,
      0,
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('no successful responses');
  });
});
