import type { CartGraph } from '../index';
import {
  cartReadCoverageGaps,
  cartReadCoverageSentence,
} from './cart-read-coverage';

/** Explains why reads and checkouts fail when an Application misses a write storage. */
export function CartReadCoverageNotice({ graph }: { graph: CartGraph }) {
  const gaps = cartReadCoverageGaps(graph);
  if (gaps.length === 0) {
    return null;
  }
  return (
    <div className="cart-run-blocked cart-notice cart-notice--info" role="note">
      <p>
        <strong>Why reads and checkouts fail</strong>
      </p>
      <p>
        A cart can be changed from any region, so a read is complete only when the
        Application reads every storage that any Application writes to. A checkout needs a
        complete read first.
      </p>
      <ul>
        {gaps.map((gap) => (
          <li key={gap.applicationId}>{cartReadCoverageSentence(gap)}</li>
        ))}
      </ul>
      <p>
        Fix: draw a request path from the Application to each missing storage and tick it
        under Read targets in Properties.
      </p>
    </div>
  );
}
