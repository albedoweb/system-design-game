import { RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { IMAGE_CATALOG } from '../catalog';
import {
  IMAGE_DELIVERY_MODES,
  IMAGE_BUFFERING_MODES,
  IMAGE_CACHE_FILL_POLICIES,
  IMAGE_CACHE_MEDIA,
  IMAGE_COMPONENT_LIMITS,
  IMAGE_DISK_TB_OPTIONS,
  IMAGE_METADATA_BACKENDS,
  IMAGE_METADATA_INDEX_MODES,
  type ImageAppConfig,
  type ImageCheck,
  type ImageDiagnostic,
  type ImageEvaluation,
  type ImageGraph,
  type ImageIssue,
  type ImageMetadataConfig,
  type ImageNode,
  type ImageNodeMetrics,
  type ImageRegion,
  type ImageScenarioName,
} from '../contracts';
import { Button } from '../../ui/Button';
import { NumberField } from '../../ui/NumberField';
import { StatusPill } from '../../ui/StatusPill';
import { TextField } from '../../ui/TextField';
import { formatInteger } from '../../ui/format';
import { validateImageGraph } from '../graph';
import { imageLogicalEdgeNote, imageAllowedOperations } from './image-canvas-model';
import {
  imageDiagnosticTarget,
  imageProblemMaps,
  imageResultStale,
  imageUniqueIssues,
  type ImageProblem,
} from './image-diagnostics';
import {
  imageCacheLimit,
  imageMetadataShardSummary,
  imageNodeCapacityLoad,
  imageLiveEstimate,
} from './image-estimate';
import {
  formatDataSize,
  formatFractionPercent,
  formatGbitPerSec,
  formatMilliseconds,
  formatTerabytes,
  formatUsd,
} from './image-format';
import {
  IMAGE_NODE_KIND_LABELS,
  IMAGE_OPERATION_META,
  IMAGE_REGION_LABELS,
  IMAGE_REGION_ORDER,
  IMAGE_SCENARIO_LABELS,
} from './image-meta';
import { useImageStore, type ImageSelection } from './image-store';

function issueSelection(issue: ImageIssue): ImageSelection {
  if (issue.nodeId) {
    return { type: 'node', id: issue.nodeId };
  }
  if (issue.edgeId) {
    return { type: 'edge', id: issue.edgeId };
  }
  return null;
}

function checkSelection(check: ImageCheck): ImageSelection {
  return check.nodeId ? { type: 'node', id: check.nodeId } : null;
}

function diagnosticSelection(
  graph: ImageGraph,
  diagnostic: ImageDiagnostic,
): ImageSelection {
  const target = imageDiagnosticTarget(graph, diagnostic);
  return target ? { type: target.type, id: target.id } : null;
}

function Problems({ problem }: { problem: ImageProblem }) {
  if (problem.messages.length === 0) {
    return null;
  }
  return (
    <ul className="image-inspector__issues">
      {problem.messages.map((message) => (
        <li
          key={message}
          className={`image-inspector__issue image-inspector__issue--${problem.severity}`}
        >
          {message}
        </li>
      ))}
    </ul>
  );
}

function MetricsSection({
  metrics,
  capacity,
  problem,
  scenario,
}: {
  metrics: ImageNodeMetrics | undefined;
  capacity: ReturnType<typeof imageNodeCapacityLoad>;
  problem: ImageProblem;
  scenario: ImageScenarioName;
}) {
  if (!metrics) {
    return null;
  }
  const netCapacity =
    metrics.kind === 'client' || metrics.kind === 'blob'
      ? IMAGE_CATALOG.provider.endpointBandwidthGbitPerSec
      : Math.max(1, metrics.instances) * IMAGE_CATALOG.instance.networkGbitPerSec;
  return (
    <section className="image-inspector__section">
      <h3>
        {IMAGE_SCENARIO_LABELS[scenario]} run metrics{' '}
        <span className="image-inspector__small">
          (measured averages and queues · run-wide peaks)
        </span>
      </h3>
      <dl className="image-inspector__metrics">
        <div>
          <dt>CPU average / peak</dt>
          <dd>
            {formatFractionPercent(metrics.cpuUtilizationAvg)} /{' '}
            {formatFractionPercent(metrics.cpuUtilizationPeak)}
          </dd>
        </div>
        <div>
          <dt>RAM average / peak</dt>
          <dd>
            {formatDataSize(metrics.memoryBytesAvg)} /{' '}
            {formatDataSize(metrics.memoryBytesPeak)} of{' '}
            {formatDataSize(metrics.memoryLimitBytes)}
          </dd>
        </div>
        <div>
          <dt>IO average / peak</dt>
          <dd>
            {formatFractionPercent(metrics.ioUtilizationAvg)} /{' '}
            {formatFractionPercent(metrics.ioUtilizationPeak)}
          </dd>
        </div>
        <div>
          <dt>Network in / out peak</dt>
          <dd>
            {formatGbitPerSec(metrics.networkIngressGbitPeak)} /{' '}
            {formatGbitPerSec(metrics.networkEgressGbitPeak)} of{' '}
            {formatGbitPerSec(netCapacity)}
          </dd>
        </div>
        <div>
          <dt title="Distinct foreground stage tasks waiting. Business requests and background replication or tail-copy work are not counted as queue entries.">
            Foreground queue average / peak
          </dt>
          <dd title="Queue-wait p95 covers attempts enqueued in the measured window, including attempts cancelled or timed out before starting; each wait lasts until start or end. It is not the total queue time across all stages.">
            {formatInteger(metrics.queueDepthAvg)} /{' '}
            {formatInteger(metrics.queueDepthPeak)} · wait p95{' '}
            {formatMilliseconds(metrics.queueWaitP95Ms)}
          </dd>
        </div>
        <div>
          <dt title="Other failed counts every non-timeout failed outcome attributed to this node. It is not specifically an admission drop and does not prove a local cause.">
            Requests / errors / other failed
          </dt>
          <dd title="Attributed non-timeout failed outcomes; not an admission-drop count and not a local root cause.">
            {formatInteger(metrics.requests)} / {formatInteger(metrics.errors)} /{' '}
            {formatInteger(metrics.rejected)}
          </dd>
        </div>
        <div>
          <dt>Timed out / healthy instances</dt>
          <dd>
            {formatInteger(metrics.timedOut)} / {metrics.healthyInstances} of{' '}
            {metrics.instances}
          </dd>
        </div>
        <div>
          <dt>Bytes read / written</dt>
          <dd>
            {formatDataSize(metrics.bytesRead)} /{' '}
            {formatDataSize(metrics.bytesWritten)}
          </dd>
        </div>
        {capacity ? (
          <div>
            <dt>{capacity.label} (analytical day 30)</dt>
            <dd>
              {formatFractionPercent(capacity.fraction)} · {capacity.detail}
            </dd>
          </div>
        ) : null}
        {metrics.cache ? (
          <div>
            <dt>Cache hit ratio / coalesced</dt>
            <dd>
              {formatFractionPercent(metrics.cache.hitRatio)} ·{' '}
              {formatInteger(metrics.cache.hits)} hits ·{' '}
              {formatInteger(metrics.cache.misses)} misses ·{' '}
              {formatInteger(metrics.cache.coalesced)} coalesced
            </dd>
          </div>
        ) : null}
        {metrics.replication ? (
          <div>
            <dt>Replication lag / queued</dt>
            <dd>
              {formatMilliseconds(metrics.replication.lagMaxMs)} ·{' '}
              {formatDataSize(metrics.replication.queuedBytes)}
            </dd>
          </div>
        ) : null}
      </dl>
      <p className="image-inspector__note">
        Averages and foreground queue figures are measured-window values; CPU, I/O,
        memory and network peaks are whole-run peaks. Requests are raw node scopes:
        app and metadata count initial assigned routes including warm-up, client is
        measured offered, and blob counts provider-access attempts including retries.
        Errors and completed are scored final outcomes by final route, so requests need
        not equal their sum.
      </p>
      {problem.messages.length > 0 ? (
        <p className="image-inspector__note">
          Reason attached to this node: {problem.messages[0]}
        </p>
      ) : null}
    </section>
  );
}

function EnumField({
  id,
  label,
  value,
  options,
  hint,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  hint: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="ui-field">
      <label className="ui-field__label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="ui-input"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option value={option.value} key={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <p className="ui-field__hint">{hint}</p>
    </div>
  );
}

interface NodeConfigFormProps {
  node: ImageNode;
  locked: boolean;
  patch: (change: Record<string, unknown>) => void;
}

/**
 * The catalog decides which fields a kind exposes. Every rendered field is
 * listed in `IMAGE_CATALOG.nodes[kind].configurableFields`; the form only
 * supplies the widget and the teaching explanation.
 */
function NodeConfigForm({ node, locked, patch }: NodeConfigFormProps) {
  const fields = IMAGE_CATALOG.nodes[node.kind].configurableFields;
  const has = (field: string): boolean => fields.includes(field);
  const app = node.kind === 'app' ? (node.config as ImageAppConfig) : null;
  const metadata =
    node.kind === 'metadata' ? (node.config as ImageMetadataConfig) : null;
  const cache = node.kind === 'cache' ? node.config : null;
  const id = (field: string): string => `image-${node.id}-${field}`;

  return (
    <>
      {has('instances') ? (
        <NumberField
          label="Instances"
          value={
            app?.instances ?? metadata?.instances ?? cache?.instances ?? 1
          }
          min={IMAGE_COMPONENT_LIMITS.instances.min}
          max={IMAGE_COMPONENT_LIMITS.instances.max}
          unit="× 8 cores"
          hint="Each instance is 8 cores, 24 GB RAM (22 GB usable), a 10 Gbit/s NIC and a 2 TB disk. A pool spreads work over its instances; one instance failing never multiplies the survivors."
          disabled={locked}
          onCommit={(value) => patch({ instances: value })}
        />
      ) : null}

      {has('delivery') && app ? (
        <EnumField
          id={id('delivery')}
          label="Delivery"
          value={app.delivery}
          options={IMAGE_DELIVERY_MODES.map((mode) => ({
            value: mode,
            label:
              mode === 'direct'
                ? 'Direct — clients read bytes from the provider'
                : 'Proxy — the app carries image bytes',
          }))}
          hint="Direct apps have no blob edge; their clients need explicit provider endpoint edges. Proxy apps have exactly one data path: to a provider or through one cache."
          disabled={locked}
          onChange={(value) => patch({ delivery: value })}
        />
      ) : null}

      {has('buffering') && app ? (
        <EnumField
          id={id('buffering')}
          label="Proxy buffering"
          value={app.buffering}
          options={IMAGE_BUFFERING_MODES.map((mode) => ({
            value: mode,
            label:
              mode === 'streaming'
                ? 'Streaming — 64 KB per active hop'
                : 'Buffered — retain the payload in RAM',
          }))}
          hint="Buffers and queues occupy RAM. Streaming keeps 64 KB per active hop; buffered mode retains the payload and reaches the hard memory cap sooner."
          disabled={locked}
          onChange={(value) => patch({ buffering: value })}
        />
      ) : null}

      {has('retries') && app ? (
        <NumberField
          label="Retries"
          value={app.retries}
          min={IMAGE_COMPONENT_LIMITS.retries.min}
          max={IMAGE_COMPONENT_LIMITS.retries.max}
          unit="retries"
          hint="A retry reuses the upload id and pays its transferred bytes again. Retries cannot create a second image or metadata record."
          disabled={locked}
          onCommit={(value) => patch({ retries: value })}
        />
      ) : null}

      {has('retryBackoffMs') && app ? (
        <NumberField
          label="Retry backoff"
          value={app.retryBackoffMs}
          min={IMAGE_COMPONENT_LIMITS.retryBackoffMs.min}
          max={IMAGE_COMPONENT_LIMITS.retryBackoffMs.max}
          step={50}
          unit="ms"
          hint="A fixed bounded backoff between attempts. It delays the retry instead of hiding the extra work."
          disabled={locked}
          onCommit={(value) => patch({ retryBackoffMs: value })}
        />
      ) : null}

      {has('backend') && metadata ? (
        <EnumField
          id={id('backend')}
          label="Backend"
          value={metadata.backend}
          options={IMAGE_METADATA_BACKENDS.map((backend) => ({
            value: backend,
            label: backend === 'sql' ? 'SQL (durable, indexed)' : 'KV (durable, key-addressed)',
          }))}
          hint={IMAGE_CATALOG.metadata.backends[metadata.backend].notes}
          disabled={locked}
          onChange={(value) => patch({ backend: value })}
        />
      ) : null}

      {has('index') && metadata ? (
        <EnumField
          id={id('index')}
          label="Index mode"
          value={metadata.index}
          options={IMAGE_METADATA_INDEX_MODES.map((mode) => ({
            value: mode,
            label:
              mode === 'none'
                ? 'None — key lookups only'
                : mode === 'user'
                  ? 'User recency index (64 B/object)'
                  : 'User + tag index (352 B/object)',
          }))}
          hint="No index cannot serve tag search cheaply or correctly. Every mode pays its own index bytes and write amplification on every local copy."
          disabled={locked}
          onChange={(value) => patch({ index: value })}
        />
      ) : null}

      {has('diskTb') && metadata ? (
        <EnumField
          id={id('diskTb')}
          label="Disk per instance"
          value={String(metadata.diskTb)}
          options={IMAGE_DISK_TB_OPTIONS.map((size) => ({
            value: String(size),
            label: `${size} TB per instance`,
          }))}
          hint="2 TB is included in the instance price. 8 TB and 16 TB are incremental disk tiers, charged per instance and per physical copy."
          disabled={locked}
          onChange={(value) => patch({ diskTb: Number(value) })}
        />
      ) : null}

      {has('replicas') && metadata ? (
        <NumberField
          label="Local durable copies"
          value={metadata.replicas}
          min={IMAGE_COMPONENT_LIMITS.replicas.min}
          max={IMAGE_COMPONENT_LIMITS.replicas.max}
          unit="copies"
          hint="An upload ACK needs object durability plus a strict majority of these local copies. Instances must be divisible by replicas."
          disabled={locked}
          onCommit={(value) => patch({ replicas: value })}
        />
      ) : null}

      {has('residentCacheGb') && metadata ? (
        <NumberField
          label="Resident metadata pages"
          value={metadata.residentCacheGb}
          min={IMAGE_COMPONENT_LIMITS.residentCacheGb.min}
          max={IMAGE_CATALOG.metadata.residentCacheMaxGbPerInstance}
          unit="GB / instance"
          hint="Resident index and buffer pages per instance. Everything else is read from disk; the whole dataset is never assumed to fit in RAM."
          disabled={locked}
          onCommit={(value) => patch({ residentCacheGb: value })}
        />
      ) : null}

      {has('medium') && node.kind === 'cache' ? (
        <EnumField
          id={id('medium')}
          label="Medium"
          value={node.config.medium}
          options={IMAGE_CACHE_MEDIA.map((medium) => ({
            value: medium,
            label: medium === 'ram' ? 'RAM (22 GB usable per instance)' : 'SSD (declared disk tier)',
          }))}
          hint="RAM capacity is bounded by each instance’s usable memory; SSD capacity is bounded by the declared disk tier. A cache is never durable storage."
          disabled={locked}
          onChange={(value) => patch({ medium: value })}
        />
      ) : null}

      {has('diskTb') && node.kind === 'cache' && node.config.medium === 'ssd' ? (
        <EnumField
          id={id('cache-diskTb')}
          label="SSD tier"
          value={String(node.config.diskTb ?? 2)}
          options={IMAGE_DISK_TB_OPTIONS.map((size) => ({
            value: String(size),
            label: `${size} TB per instance`,
          }))}
          hint="The SSD tier is charged through the incremental disk price and bounds the per-instance cache capacity."
          disabled={locked}
          onChange={(value) => patch({ diskTb: Number(value) })}
        />
      ) : null}

      {has('capacityGb') && node.kind === 'cache' ? (
        <NumberField
          label="Total cache capacity"
          value={node.config.capacityGb}
          min={IMAGE_COMPONENT_LIMITS.cacheCapacityGb.min}
          max={IMAGE_COMPONENT_LIMITS.cacheCapacityGb.max}
          unit="GB"
          hint="Total pool capacity in decimal GB. The per-instance share is capacity divided by instances and must fit the medium limit."
          disabled={locked}
          onCommit={(value) => patch({ capacityGb: value })}
        />
      ) : null}

      {has('fill') && node.kind === 'cache' ? (
        <EnumField
          id={id('fill')}
          label="Miss fill policy"
          value={node.config.fill}
          options={IMAGE_CACHE_FILL_POLICIES.map((fill) => ({
            value: fill,
            label:
              fill === 'coalesce'
                ? 'Coalesce — one provider fill per key'
                : 'Independent — each miss fills separately',
          }))}
          hint="Coalescing protects the provider from a stampede on a cold popular key. It never turns a miss into a hit."
          disabled={locked}
          onChange={(value) => patch({ fill: value })}
        />
      ) : null}
    </>
  );
}

function FixedEndpointFacts({ node }: { node: ImageNode }) {
  const config = node.config as unknown as Record<string, unknown>;
  return (
    <section className="image-inspector__section">
      <h3>Fixed contract</h3>
      <p className="image-inspector__note">
        {IMAGE_CATALOG.nodes[node.kind].notes}
      </p>
      <dl className="image-inspector__metrics">
        {Object.entries(config).map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{String(value)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function NodeInspector({
  node,
  graph,
  locked,
  scenario,
  metrics,
  problem,
  stale,
}: {
  node: ImageNode;
  graph: ImageGraph;
  locked: boolean;
  scenario: ImageScenarioName;
  metrics: ImageNodeMetrics | undefined;
  problem: ImageProblem;
  stale: boolean;
}) {
  const update = useImageStore((state) => state.updateNodeConfig);
  const updateLabel = useImageStore((state) => state.updateNodeLabel);
  const setRegion = useImageStore((state) => state.setNodeRegion);
  const reset = useImageStore((state) => state.resetNodeConfig);
  const remove = useImageStore((state) => state.removeNode);
  const [message, setMessage] = useState<string | null>(null);
  const fixed = IMAGE_CATALOG.nodes[node.kind].fixed;
  const estimate = imageLiveEstimate(graph);
  const capacity = imageNodeCapacityLoad(estimate.capacity, node.id);
  const nodeCost = estimate.cost.byNode.find((item) => item.nodeId === node.id);
  const metadataUsage = estimate.capacity.metadataNodes.find(
    (item) => item.nodeId === node.id,
  );
  const cacheUsage = estimate.capacity.caches.find(
    (item) => item.nodeId === node.id,
  );
  const appUsage = estimate.capacity.apps.find((item) => item.nodeId === node.id);
  const patch = (change: Record<string, unknown>) => {
    const result = update(node.id, change);
    setMessage(result.ok ? null : (result.message ?? null));
  };

  return (
    <div className="image-inspector">
      <header className="image-inspector__head">
        <div>
          <p className="image-inspector__eyebrow">
            {IMAGE_NODE_KIND_LABELS[node.kind]} · {IMAGE_REGION_LABELS[node.region]}
          </p>
          <h2>{node.label}</h2>
        </div>
        <StatusPill tone={fixed ? 'neutral' : 'accent'}>
          {fixed
            ? 'Fixed'
            : `${formatUsd(nodeCost?.totalMonthlyUsd ?? 0, 0)}/mo`}
        </StatusPill>
      </header>

      <TextField
        label="Name"
        value={node.label}
        maxLength={IMAGE_COMPONENT_LIMITS.labelMaxLength}
        hint="The label is display-only and never changes semantics or the graph digest."
        disabled={locked}
        onCommit={(label) => {
          const result = updateLabel(node.id, label);
          setMessage(result.ok ? null : (result.message ?? null));
        }}
      />

      <EnumField
        id={`image-${node.id}-region`}
        label="Region"
        value={node.region}
        options={IMAGE_REGION_ORDER.map((region) => ({
          value: region,
          label: `${IMAGE_REGION_LABELS[region]} (${region})`,
        }))}
        hint={
          fixed
            ? 'A fixed endpoint is bound to its region by the level contract.'
            : 'Region selects the demand, fault domain and cross-region latency. Moving the node to another region lane only changes its canvas row.'
        }
        disabled={locked || fixed}
        onChange={(value) => {
          const result = setRegion(node.id, value as ImageRegion);
          setMessage(result.ok ? null : (result.message ?? null));
        }}
      />

      {fixed ? (
        <FixedEndpointFacts node={node} />
      ) : (
        <NodeConfigForm node={node} locked={locked} patch={patch} />
      )}

      {node.kind === 'metadata' ? (
        <section className="image-inspector__section">
          <h3>Derived capacity</h3>
          <dl className="image-inspector__metrics">
            <div>
              <dt>Shards (instances / copies)</dt>
              <dd>
                {imageMetadataShardSummary(node).shardCount} ·{' '}
                {imageMetadataShardSummary(node).divisible ? 'divisible' : 'not divisible'}
              </dd>
            </div>
            <div>
              <dt>Logical capacity</dt>
              <dd>
                {formatTerabytes(imageMetadataShardSummary(node).logicalCapacityTb)}
              </dd>
            </div>
            <div>
              <dt>Provisioned disk</dt>
              <dd>
                {formatTerabytes(imageMetadataShardSummary(node).provisionedDiskTb)} across{' '}
                {node.config.instances} instances
              </dd>
            </div>
            <div>
              <dt>Roles</dt>
              <dd>
                {metadataUsage
                  ? metadataUsage.roles.length > 0
                    ? metadataUsage.roles.join(', ')
                    : 'unused'
                  : 'unused'}
              </dd>
            </div>
            <div>
              <dt>Dataset held per store</dt>
              <dd>
                {metadataUsage
                  ? `${formatTerabytes(metadataUsage.serviceDataTb)} logical · ${formatTerabytes(metadataUsage.physicalDataTb)} physical`
                  : '—'}
              </dd>
            </div>
            <div>
              <dt>Replication sources</dt>
              <dd>
                {metadataUsage && metadataUsage.replicationSources.length > 0
                  ? metadataUsage.replicationSources.join(', ')
                  : 'none (origin only)'}
              </dd>
            </div>
          </dl>
        </section>
      ) : null}

      {node.kind === 'app' && appUsage ? (
        <section className="image-inspector__section">
          <h3>Derived resources</h3>
          <dl className="image-inspector__metrics">
            <div>
              <dt>Instances</dt>
              <dd>{appUsage.instances}</dd>
            </div>
            <div>
              <dt>Memory / network</dt>
              <dd>
                {formatTerabytes(appUsage.memoryGb / 1000)} ·{' '}
                {formatGbitPerSec(appUsage.networkGbitPerSec)}
              </dd>
            </div>
            <div>
              <dt>Delivery / buffering</dt>
              <dd>
                {appUsage.delivery} · {appUsage.buffering}
              </dd>
            </div>
          </dl>
        </section>
      ) : null}

      {node.kind === 'cache' && cacheUsage ? (
        <section className="image-inspector__section">
          <h3>Derived capacity</h3>
          <dl className="image-inspector__metrics">
            <div>
              <dt>Per instance</dt>
              <dd>
                {cacheUsage.perInstanceCapacityGb.toFixed(1)} of{' '}
                {cacheUsage.limitGbPerInstance.toFixed(1)} GB ·{' '}
                {imageCacheLimit(node).fits ? 'fits' : 'does not fit'}
              </dd>
            </div>
            <div>
              <dt>Total capacity</dt>
              <dd>{cacheUsage.capacityGb} GB across {cacheUsage.instances} instances</dd>
            </div>
            <div>
              <dt>Fill target</dt>
              <dd>
                {estimate.routes.caches.find((item) => item.cacheId === node.id)
                  ?.providerId ?? 'no provider path'}
              </dd>
            </div>
          </dl>
        </section>
      ) : null}

      {problem.messages.length > 0 ? (
        <section className="image-inspector__section">
          <h3>Current issues for this node</h3>
          <Problems problem={problem} />
        </section>
      ) : null}

      <MetricsSection
        metrics={metrics}
        capacity={capacity}
        problem={problem}
        scenario={scenario}
      />
      {stale ? (
        <p className="image-inspector__note" role="status">
          Previous result hidden — the semantic graph or seed changed. Run again to see
          metrics for this node.
        </p>
      ) : null}

      <div className="image-inspector__actions">
        <Button
          variant="secondary"
          size="sm"
          icon={<RotateCcw size={15} />}
          disabled={locked || fixed}
          onClick={() => {
            const result = reset(node.id);
            setMessage(
              result.ok ? 'Settings reset to catalog defaults.' : (result.message ?? null),
            );
          }}
        >
          Reset settings
        </Button>
        {!fixed ? (
          <Button
            variant="danger"
            size="sm"
            icon={<Trash2 size={15} />}
            disabled={locked}
            onClick={() => {
              const result = remove(node.id);
              setMessage(result.ok ? null : (result.message ?? null));
            }}
          >
            Delete node
          </Button>
        ) : null}
      </div>
      {message ? (
        <p className="image-inspector__message" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}

function edgeRole(graph: ImageGraph, edgeId: string): string {
  const edge = graph.edges.find((item) => item.id === edgeId);
  if (!edge) {
    return '';
  }
  const source = graph.nodes.find((node) => node.id === edge.source);
  const target = graph.nodes.find((node) => node.id === edge.target);
  if (!source || !target) {
    return '';
  }
  if (edge.operation === 'traffic') {
    return 'Failover choice: this client population may use this app. The engine selects the lowest-latency healthy connected app after 250 ms.';
  }
  if (edge.operation === 'metadata') {
    return 'Selects this store for the app’s reads and for new immutable uploads, which makes the store an origin writer.';
  }
  if (edge.operation === 'replicate') {
    return 'Direct origin log to this recipient. Records are applied once per recipient and never rebroadcast transitively.';
  }
  if (source.kind === 'client') {
    return 'Direct provider endpoint choice for this client population. Only valid when a connected app delivers directly.';
  }
  if (source.kind === 'cache') {
    return 'The cache fills from this provider endpoint on a miss. A hit still uses the client link.';
  }
  return target.kind === 'cache'
    ? 'Proxy data path through this cache to its provider. The cache must point at exactly one provider.'
    : 'Proxy data path: this app carries the image bytes from the provider.';
}

function EdgeInspector({
  edgeId,
  graph,
  locked,
  problem,
}: {
  edgeId: string;
  graph: ImageGraph;
  locked: boolean;
  problem: ImageProblem;
}) {
  const edge = graph.edges.find((item) => item.id === edgeId);
  const update = useImageStore((state) => state.updateEdgeOperation);
  const remove = useImageStore((state) => state.removeEdge);
  const [message, setMessage] = useState<string | null>(null);
  if (!edge) {
    return null;
  }
  const source = graph.nodes.find((node) => node.id === edge.source);
  const target = graph.nodes.find((node) => node.id === edge.target);
  const allowed = source && target
    ? imageAllowedOperations(source.kind, target.kind)
    : [];

  return (
    <div className="image-inspector">
      <header className="image-inspector__head">
        <div>
          <p className="image-inspector__eyebrow">Route</p>
          <h2>
            {source?.label ?? edge.source} → {target?.label ?? edge.target}
          </h2>
        </div>
        <StatusPill tone="neutral">{IMAGE_OPERATION_META[edge.operation].label}</StatusPill>
      </header>

      <div className="ui-field">
        <label className="ui-field__label" htmlFor={`image-edge-operation-${edge.id}`}>
          Operation
        </label>
        <select
          id={`image-edge-operation-${edge.id}`}
          className="ui-input"
          value={edge.operation}
          disabled={locked || allowed.length <= 1}
          onChange={(event) => {
            const result = update(edge.id, event.target.value as typeof edge.operation);
            setMessage(result.ok ? null : (result.message ?? null));
          }}
        >
          {allowed.map((operation) => (
            <option value={operation} key={operation}>
              {IMAGE_OPERATION_META[operation].label}
            </option>
          ))}
        </select>
        <p className="ui-field__hint">
          {IMAGE_OPERATION_META[edge.operation].description}
        </p>
      </div>

      <p className="image-inspector__note">{edgeRole(graph, edge.id)}</p>
      <p className="image-inspector__note">{imageLogicalEdgeNote(edge.operation)}</p>

      {problem.messages.length > 0 ? (
        <section className="image-inspector__section">
          <h3>Issues on this route</h3>
          <Problems problem={problem} />
        </section>
      ) : null}

      <div className="image-inspector__actions">
        <Button
          variant="danger"
          size="sm"
          icon={<Trash2 size={15} />}
          disabled={locked}
          onClick={() => {
            const result = remove(edge.id);
            setMessage(result.ok ? null : (result.message ?? null));
          }}
        >
          Delete route
        </Button>
      </div>
      {message ? (
        <p className="image-inspector__message" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}

function IssuesList({
  graph,
  evaluation,
  stale,
  scenario,
}: {
  graph: ImageGraph;
  evaluation: ImageEvaluation | null;
  stale: boolean;
  scenario: ImageScenarioName;
}) {
  const select = useImageStore((state) => state.select);
  const validation = imageUniqueIssues(validateImageGraph(graph, { mode: 'edit' }));
  const scenarioResult =
    evaluation && !stale
      ? evaluation.scenarios.find((item) => item.name === scenario)
      : null;
  const failedChecks = evaluation && !stale
    ? [
        ...evaluation.checks.filter((check) => !check.passed),
        ...(scenarioResult?.checks.filter((check) => !check.passed) ?? []),
      ]
    : [];
  const diagnostics = evaluation && !stale
    ? [...evaluation.diagnostics, ...(scenarioResult?.diagnostics ?? [])]
    : [];
  const total = validation.length + failedChecks.length + diagnostics.length;

  return (
    <div className="image-inspector">
      <header className="image-inspector__head">
        <div>
          <p className="image-inspector__eyebrow">Diagnostics</p>
          <h2>Issues</h2>
        </div>
        <StatusPill tone={total > 0 ? 'warning' : 'success'}>{total} open</StatusPill>
      </header>
      <p className="image-inspector__note">
        Validation errors block a run. Capacity failures, failed gates and engine
        diagnostics come from the last completed run for{' '}
        {IMAGE_SCENARIO_LABELS[scenario]}.
      </p>
      {total === 0 ? (
        <p className="image-inspector__empty">
          No current validation, check or diagnostic issues.
        </p>
      ) : null}

      {validation.length > 0 ? (
        <section className="image-inspector__section">
          <h3>Validation</h3>
          <ul className="image-inspector__issues">
            {validation.map((issue, index) => {
              const selection = issueSelection(issue);
              return (
                <li
                  key={`${issue.code}-${index}`}
                  className={`image-inspector__issue image-inspector__issue--${issue.severity}`}
                >
                  <span>{issue.message}</span>
                  {selection ? (
                    <button type="button" onClick={() => select(selection)}>
                      Show
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {failedChecks.length > 0 ? (
        <section className="image-inspector__section">
          <h3>Failed gates</h3>
          <ul className="image-inspector__issues">
            {failedChecks.map((check, index) => {
              const selection = checkSelection(check);
              return (
                <li
                  key={`${check.id}-${index}`}
                  className={`image-inspector__issue image-inspector__issue--${
                    check.severity === 'required' ? 'error' : 'warning'
                  }`}
                >
                  <span>
                    {check.label}: {check.message}
                  </span>
                  {selection ? (
                    <button type="button" onClick={() => select(selection)}>
                      Focus
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {diagnostics.length > 0 ? (
        <section className="image-inspector__section">
          <h3>Engine diagnostics</h3>
          <ul className="image-inspector__issues">
            {diagnostics.map((diagnostic, index) => {
              const selection = diagnosticSelection(graph, diagnostic);
              return (
                <li
                  key={`${diagnostic.id}-${index}`}
                  className={`image-inspector__issue image-inspector__issue--${diagnostic.severity}`}
                >
                  <span>{diagnostic.message}</span>
                  {selection ? (
                    <button type="button" onClick={() => select(selection)}>
                      Focus
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export function ImageInspector({
  tab,
  setTab,
}: {
  tab: 'properties' | 'issues';
  setTab: (tab: 'properties' | 'issues') => void;
}) {
  const graph = useImageStore((state) => state.graph);
  const selection = useImageStore((state) => state.selection);
  const result = useImageStore((state) => state.result);
  const resultDigest = useImageStore((state) => state.resultDigest);
  const resultSeed = useImageStore((state) => state.resultSeed);
  const seed = useImageStore((state) => state.seed);
  const selectedScenario = useImageStore((state) => state.selectedScenario);
  const runPhase = useImageStore((state) => state.runPhase);
  const runIssues = useImageStore((state) => state.runIssues);
  const locked = runPhase === 'running' || runPhase === 'stopping';
  const stale = imageResultStale(result, resultDigest, resultSeed, graph, seed);
  const selectedNode =
    selection?.type === 'node'
      ? graph.nodes.find((node) => node.id === selection.id) ?? null
      : null;

  const problems = imageProblemMaps({
    graph,
    issues: [
      ...validateImageGraph(graph, { mode: 'edit' }),
      ...(runPhase === 'blocked' ? runIssues : []),
    ],
    evaluation: result && !stale ? result : null,
    scenario: stale ? null : selectedScenario,
  });
  const scenarioResult =
    result && !stale
      ? result.scenarios.find((item) => item.name === selectedScenario)
      : null;
  const metrics = selectedNode
    ? scenarioResult?.nodes.find((item) => item.nodeId === selectedNode.id)
    : undefined;

  return (
    <div className="image-inspector-shell">
      <div className="image-inspector-tabs" role="tablist" aria-label="Inspector">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'properties'}
          className={tab === 'properties' ? 'is-active' : ''}
          onClick={() => setTab('properties')}
        >
          Properties
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'issues'}
          className={tab === 'issues' ? 'is-active' : ''}
          onClick={() => setTab('issues')}
        >
          Issues
        </button>
      </div>
      <div className="image-inspector-scroll">
        {tab === 'issues' ? (
          <IssuesList
            graph={graph}
            evaluation={result}
            stale={stale}
            scenario={selectedScenario}
          />
        ) : selectedNode ? (
          <NodeInspector
            node={selectedNode}
            graph={graph}
            locked={locked}
            scenario={selectedScenario}
            metrics={metrics}
            problem={
              problems.byNode.get(selectedNode.id) ?? {
                severity: 'info',
                messages: [],
                byMetric: {},
              }
            }
            stale={stale}
          />
        ) : selection?.type === 'edge' ? (
          <EdgeInspector
            edgeId={selection.id}
            graph={graph}
            locked={locked}
            problem={
              problems.byEdge.get(selection.id) ?? {
                severity: 'info',
                messages: [],
                byMetric: {},
              }
            }
          />
        ) : (
          <div className="image-inspector image-inspector--empty">
            <h2>Inspector</h2>
            <p>
              Select a node or route. Every kind exposes exactly the catalog fields it
              supports, with the resource consequence next to each setting.
            </p>
            <p>
              Client populations and provider endpoints are fixed: their kind, region and
              configuration are locked, while the label and position stay editable.
            </p>
            <p>
              A node meter links its reason to the engine diagnostic that explains it,
              so a high reading is never presented as a cause on its own.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
