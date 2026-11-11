import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import {
  evaluateParcel,
  parcelEvaluationJsonSchema,
  type ParcelEvaluation,
} from '../index';
import { fixture } from './helpers';

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validate = ajv.compile(parcelEvaluationJsonSchema());

function expectSchema(value: unknown, expected: boolean): void {
  const actual = validate(value);
  if (actual !== expected) {
    throw new Error(
      `expected schema=${String(expected)}, errors=${JSON.stringify(
        validate.errors,
      )}`,
    );
  }
}

function clone(result: ParcelEvaluation): Record<string, unknown> {
  return JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
}

describe('evaluation result JSON schema', () => {
  it('validates a complete passing evaluation with both horizons', () => {
    const result = evaluateParcel(fixture('family-sql-indexed'), { seed: 101 });
    expect(result.status).toBe('ok');
    expect(result.passed).toBe(true);
    expectSchema(result, true);
  });

  it('validates a completed but failing evaluation', () => {
    const result = evaluateParcel(fixture('starter'), { seed: 101 });
    expect(result.status).toBe('ok');
    expect(result.passed).toBe(false);
    expectSchema(result, true);
  });

  it('validates invalid and error results as false passes', () => {
    const invalid = evaluateParcel({ schemaVersion: 1, nodes: 'nope' }, { seed: 101 });
    expect(invalid.status).toBe('invalid');
    expectSchema(invalid, true);

    const error = evaluateParcel(fixture('family-sql-indexed'), { seed: -1 });
    expect(error.status).toBe('error');
    expectSchema(error, true);
  });

  it('allows a partial investigation with passed:false and one horizon', () => {
    const partial = evaluateParcel(fixture('family-sql-indexed'), {
      seed: 101,
      horizons: [1],
    });
    expect(partial.status).toBe('ok');
    expect(partial.passed).toBe(false);
    expectSchema(partial, true);
  });

  it('rejects an empty false-passing payload and missing mandatory evidence', () => {
    expectSchema(
      {
        status: 'ok',
        passed: true,
        meta: {
          schemaVersion: 1,
          modelVersion: '1.0.0',
          pricingVersion: 'parcel-catalog-v1',
          contentVersion: '1.0.0',
          levelId: 'parcel-pulse',
          seed: 101,
          graphDigest: 'deadbeef',
          requestedHorizons: [1, 5],
          requiredHorizons: [1, 5],
          sampleFactor: 1,
        },
        issues: [],
        diagnostics: [],
        assumptions: [],
        horizons: [],
        capacity: null,
        cost: null,
        checks: [],
      },
      false,
    );

    const real = clone(
      evaluateParcel(fixture('family-sql-indexed'), { seed: 101 }),
    );
    expectSchema(real, true);
    const missingYear5 = {
      ...real,
      horizons: (real.horizons as unknown[]).slice(0, 1),
    };
    expectSchema(missingYear5, false);
  });

  it('rejects malformed nested counts and missing horizon checks', () => {
    const real = clone(
      evaluateParcel(fixture('family-sql-indexed'), { seed: 101 }),
    );
    const malformed = JSON.parse(JSON.stringify(real)) as {
      horizons: { operations: { status: { counts: Record<string, unknown> } } }[];
    };
    malformed.horizons[0]!.operations.status.counts.offered = 'many';
    expectSchema(malformed, false);

    const missingChecks = JSON.parse(JSON.stringify(real)) as {
      horizons: { checks: unknown[] }[];
    };
    missingChecks.horizons[0]!.checks = [];
    expectSchema(missingChecks, false);

    const noCounts = JSON.parse(JSON.stringify(real)) as {
      horizons: { operations: { status: { counts: Record<string, unknown> } } }[];
    };
    delete noCounts.horizons[0]!.operations.status.counts.success;
    expectSchema(noCounts, false);

    const zeroEvidence = JSON.parse(JSON.stringify(real)) as {
      horizons: { operations: { status: { counts: { success: number } } } }[];
    };
    zeroEvidence.horizons[0]!.operations.status.counts.success = 0;
    expectSchema(zeroEvidence, false);
  });

  it('rejects a passing horizon that omits a required gate ID', () => {
    const real = clone(
      evaluateParcel(fixture('family-sql-indexed'), { seed: 101 }),
    );
    const missingAvailability = JSON.parse(JSON.stringify(real)) as {
      horizons: { checks: { id: string }[] }[];
    };
    missingAvailability.horizons[0]!.checks = missingAvailability.horizons[0]!.checks.filter(
      (check) => check.id !== 'availability:status',
    );
    expectSchema(missingAvailability, false);

    const missingCohort = JSON.parse(JSON.stringify(real)) as {
      horizons: { horizonYears: number; checks: { id: string }[] }[];
    };
    const year5 = missingCohort.horizons.find(
      (horizon) => horizon.horizonYears === 5,
    );
    expect(year5).toBeDefined();
    year5!.checks = year5!.checks.filter(
      (check) => check.id !== 'historical_cohort',
    );
    expectSchema(missingCohort, false);
  });

  it('rejects a passing horizon that omits every per-store storage gate', () => {
    const real = clone(
      evaluateParcel(fixture('family-sql-indexed'), { seed: 101 }),
    );
    const withoutStorage = JSON.parse(JSON.stringify(real)) as {
      horizons: { checks: { id: string }[] }[];
    };
    for (const horizon of withoutStorage.horizons) {
      horizon.checks = horizon.checks.filter(
        (check) => !check.id.startsWith('storage_capacity:'),
      );
    }
    expectSchema(withoutStorage, false);

    const oneStorageGate = JSON.parse(JSON.stringify(real)) as {
      horizons: { checks: { id: string }[] }[];
    };
    for (const horizon of oneStorageGate.horizons) {
      const storageChecks = horizon.checks.filter((check) =>
        check.id.startsWith('storage_capacity:'),
      );
      expect(storageChecks.length).toBeGreaterThan(0);
      horizon.checks = horizon.checks.filter(
        (check) => !check.id.startsWith('storage_capacity:'),
      );
      horizon.checks.push(storageChecks[0]!);
    }
    expectSchema(oneStorageGate, true);
  });
});
