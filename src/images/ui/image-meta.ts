import type {
  ImageBusinessOperation,
  ImageNodeKind,
  ImageOperation,
  ImageRegion,
  ImageScenarioName,
} from '../contracts';

export interface ImageOperationMeta {
  readonly label: string;
  readonly color: string;
  /** Player-facing explanation, shown in the inspector and connect dialog. */
  readonly description: string;
  readonly order: number;
  /** Structural distinction that survives colour-blind rendering. */
  readonly dash: string | undefined;
}

/**
 * Edge colours are structural: they identify the operation and never depend on
 * the freshness of an evaluation result.
 */
export const IMAGE_OPERATION_META: Readonly<
  Record<ImageOperation, ImageOperationMeta>
> = {
  traffic: {
    label: 'Traffic',
    color: '#0e7490',
    order: 0,
    dash: undefined,
    description:
      'Business requests and responses between a fixed regional Client population and an app pool. A client may list several apps as explicit failover choices.',
  },
  metadata: {
    label: 'Metadata',
    color: '#1d4ed8',
    order: 1,
    dash: undefined,
    description:
      'The app selects exactly one metadata store for its reads and for new immutable uploads. That store becomes an origin writer.',
  },
  blob: {
    label: 'Blob',
    color: '#b45309',
    order: 2,
    dash: undefined,
    description:
      'Image bytes. Direct clients read from a provider endpoint; a proxy app carries bytes to a provider or through one cache that points at one provider.',
  },
  replicate: {
    label: 'Replicate',
    color: '#7c3aed',
    order: 3,
    dash: '7 4',
    description:
      'Direct origin-to-recipient metadata log. Cycles of replicate edges are allowed and deduped per origin; records are never rebroadcast transitively.',
  },
};

export const IMAGE_NODE_KIND_LABELS: Readonly<Record<ImageNodeKind, string>> = {
  client: 'Client population',
  app: 'Application pool',
  metadata: 'Metadata store',
  cache: 'Byte-bounded cache',
  blob: 'Global blob endpoint',
};

export const IMAGE_NODE_KIND_SHORT: Readonly<Record<ImageNodeKind, string>> = {
  client: 'Client',
  app: 'App',
  metadata: 'Metadata',
  cache: 'Cache',
  blob: 'Blob',
};

/** Player-provisioned kinds. Client and blob are fixed endpoints. */
export const IMAGE_ADDABLE_KINDS: readonly ImageNodeKind[] = [
  'app',
  'metadata',
  'cache',
];

export const IMAGE_FIXED_KINDS: readonly ImageNodeKind[] = ['client', 'blob'];

export const IMAGE_REGION_LABELS: Readonly<Record<ImageRegion, string>> = {
  na: 'North America',
  eu: 'Europe',
  ap: 'Asia Pacific',
};

export const IMAGE_REGION_SHORT: Readonly<Record<ImageRegion, string>> = {
  na: 'NA',
  eu: 'EU',
  ap: 'AP',
};

export const IMAGE_REGION_ORDER: readonly ImageRegion[] = ['na', 'eu', 'ap'];

export const IMAGE_BUSINESS_OPERATION_LABELS: Readonly<
  Record<ImageBusinessOperation, string>
> = {
  upload: 'Upload',
  search: 'Search',
  detail: 'Detail',
};

export const IMAGE_BUSINESS_ORDER: readonly ImageBusinessOperation[] = [
  'upload',
  'search',
  'detail',
];

export const IMAGE_SCENARIO_LABELS: Readonly<
  Record<ImageScenarioName, string>
> = {
  normal: 'Normal daily average',
  peak: 'Peak daily average',
  'node-failure': 'One instance per pool',
  'link-failure': 'Link outage na-eu',
  'region-na-failure': 'Region outage: NA',
  'region-eu-failure': 'Region outage: EU',
  'region-ap-failure': 'Region outage: AP',
};

export function formatImageScenario(name: ImageScenarioName | null): string {
  return name === null ? 'Preparing' : IMAGE_SCENARIO_LABELS[name];
}

/** Scenario cases that inject a fault and therefore carry window evidence. */
export function imageScenarioIsIncident(name: ImageScenarioName): boolean {
  return name !== 'normal' && name !== 'peak';
}

export const IMAGE_PHASE_LABELS: Readonly<Record<string, string>> = {
  validate: 'Validating the graph',
  capacity: 'Estimating day-30 capacity and cost',
  workload: 'Building the seeded workload trace',
  simulate: 'Simulating scenarios',
  done: 'Evaluation finished',
};
