import {
  type AudienceCatalog,
  type AudienceLevel,
  type AudienceSqlSize,
} from '../contracts';
import { AUDIENCE_CATALOG } from '../catalog';
import { AUDIENCE_LEVEL } from '../level';

/**
 * Internal engine model for one Live Audience evaluation.
 *
 * The public API always uses the frozen level and catalog. Tests may build a
 * tiny level/catalog pair and hand it to the engine constructor directly, but
 * `AudienceRunOptions` can never override the dataset, workload, prices, work
 * coefficients or gates through the public entry points.
 */
export interface AudienceModel {
  readonly level: AudienceLevel;
  readonly catalog: AudienceCatalog;
}

export const AUDIENCE_DEFAULT_MODEL: AudienceModel = {
  level: AUDIENCE_LEVEL,
  catalog: AUDIENCE_CATALOG,
};

export function audienceSqlSpec(
  model: AudienceModel,
  size: AudienceSqlSize,
): AudienceCatalog['components']['sql']['sizes'][AudienceSqlSize] {
  return model.catalog.components.sql.sizes[size];
}
