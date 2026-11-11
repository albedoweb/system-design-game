import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateImages } from '../evaluate';
import { imageEvaluationSchema } from '../contracts';

function fixture(file: string): unknown {
  return JSON.parse(readFileSync(join(process.cwd(), 'fixtures', 'images', file), 'utf8'));
}

describe('evaluateImages', () => {
  it('rejects a document whose fixed endpoint was altered', () => {
    const result = evaluateImages(fixture('fail-invalid-fixed-node.json'), {
      seed: 101,
      scenarios: ['normal'],
    });
    expect(result.status).toBe('invalid');
    expect(result.passed).toBe(false);
    expect(result.scenarios).toHaveLength(0);
    expect(result.issues.some((issue) => issue.severity === 'error')).toBe(true);
  });

  it('runs a bounded normal scenario and returns schema-valid measured evidence', () => {
    const result = evaluateImages(fixture('family-direct.json'), {
      seed: 101,
      scenarios: ['normal'],
    });
    expect(result.status).toBe('complete');
    // An exploratory single-scenario run can never report a qualification pass.
    expect(result.meta.evaluationKind).toBe('exploratory');
    expect(result.passed).toBe(false);
    expect(result.capacity?.capacityOk).toBe(true);
    expect(result.cost?.provenance.measured).toBe(true);
    const scenario = result.scenarios[0];
    expect(scenario?.name).toBe('normal');
    expect(scenario?.operations.upload.counts.offered).toBeGreaterThan(0);
    expect(scenario?.operations.detail.counts.success).toBeGreaterThan(0);
    // The result is re-validated by the frozen runtime contract.
    expect(imageEvaluationSchema.safeParse(result).success).toBe(true);
  }, 120_000);

  it('returns a schema-valid complete failure for a saturated bad graph', () => {
    const result = evaluateImages(fixture('starter.json'), {
      seed: 101,
      scenarios: ['peak'],
    });
    expect(result.status).toBe('complete');
    expect(result.passed).toBe(false);
    expect(imageEvaluationSchema.safeParse(result).success).toBe(true);
    const scenario = result.scenarios[0];
    expect(scenario?.name).toBe('peak');
    expect(scenario?.operations.detail.counts.unfinished).toBe(0);
    expect(scenario?.checks.some((check) => check.severity === 'required' && !check.passed)).toBe(
      true,
    );
  }, 120_000);

  it('requires measured cost before a qualification pass', () => {
    const result = evaluateImages(fixture('family-direct.json'), {
      seed: 101,
      scenarios: ['peak'],
    });
    expect(result.cost?.provenance.measured).toBe(false);
    expect(result.passed).toBe(false);
  }, 120_000);
});
