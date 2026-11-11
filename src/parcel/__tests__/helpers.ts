import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function fixture(name: string): unknown {
  const path = resolve(process.cwd(), 'fixtures', 'parcel', `${name}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

export const FAMILY_FIXTURES = [
  'family-sql-indexed',
  'family-sql-rollups',
  'family-kv-rollups',
  'family-hybrid-analytics',
] as const;

export const TRAINING_SEEDS = [101, 211, 307] as const;
export const HOLDOUT_SEEDS = [607, 701] as const;
