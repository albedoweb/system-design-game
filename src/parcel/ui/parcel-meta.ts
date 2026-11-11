import type {
  ParcelBusinessOperation,
  ParcelNodeKind,
  ParcelOperation,
} from '../contracts';

export interface ParcelOperationMeta {
  readonly label: string;
  readonly short: string;
  readonly color: string;
  /** Player-facing explanation, not jargon alone. */
  readonly description: string;
  readonly order: number;
}

export const PARCEL_OPERATION_META: Readonly<
  Record<ParcelOperation, ParcelOperationMeta>
> = {
  traffic: {
    label: 'Traffic',
    short: 'traffic',
    color: '#0e7490',
    description:
      'Client requests enter the application. This route is fixed and carries all four business operations.',
    order: 0,
  },
  ingest: {
    label: 'Ingest',
    short: 'ingest',
    color: '#7c3aed',
    description:
      'Each accepted event is written to a durable SQL or KV primary. The acknowledgement means the primary committed the write.',
    order: 1,
  },
  status: {
    label: 'Status',
    short: 'status',
    color: '#1d6fd8',
    description:
      'A parcel lookup for current status. A maintained latest-status row reduces read work; without it the store must look up the parcel history.',
    order: 2,
  },
  history: {
    label: 'History',
    short: 'history',
    color: '#b45309',
    description:
      'A parcel lookup for its retained events. SQL needs a parcel index, KV uses parcel buckets, and a columnar scan is usually too slow.',
    order: 3,
  },
  report: {
    label: 'Report',
    short: 'report',
    color: '#0f766e',
    description:
      'A scheduled warehouse aggregate over the last 30 days. Rollups, a warehouse index or a columnar projection keep the scan bounded.',
    order: 4,
  },
  replicate: {
    label: 'Replicate',
    short: 'replicate',
    color: '#be123c',
    description:
      'Asynchronous copy from the ingest primary to another store. Replication is queued work, so freshness follows completion lag.',
    order: 5,
  },
};

export const PARCEL_BUSINESS_OPERATION_LABELS: Readonly<
  Record<ParcelBusinessOperation, string>
> = {
  status: 'Status',
  history: 'History',
  ingest: 'Ingest',
  report: 'Reports',
};

export const PARCEL_NODE_KIND_LABELS: Readonly<Record<ParcelNodeKind, string>> = {
  client: 'Client',
  app: 'Application',
  sql: 'SQL store',
  kv: 'KV store',
  columnar: 'Columnar analytics',
};

export const PARCEL_STORE_KINDS: readonly ParcelNodeKind[] = [
  'sql',
  'kv',
  'columnar',
];

export const PARCEL_ADDABLE_KINDS: readonly ParcelNodeKind[] = [
  'app',
  'sql',
  'kv',
  'columnar',
  'client',
];

export function parcelEdgeColor(operation: ParcelOperation): string {
  return PARCEL_OPERATION_META[operation].color;
}
