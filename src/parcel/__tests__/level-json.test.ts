import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PARCEL_LEVEL } from '../index';

describe('public level JSON', () => {
  it('matches the authoritative TypeScript level definition', () => {
    const path = resolve(process.cwd(), 'public', 'levels', 'parcel-pulse.json');
    const file = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    expect(file).toEqual(PARCEL_LEVEL);
  });
});
