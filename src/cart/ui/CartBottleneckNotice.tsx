import type { CartEvaluation, CartGraph } from '../index';
import { cartBottleneckSentence, cartBottlenecks } from './cart-bottleneck';
import { cartCasePassed, cartCaseLabel } from './cart-diagnostics';

/** Sentences listed per scenario before the "+ N more" pointer. */
const NOTICE_LIMIT = 5;

/** Names the overloaded components of every scenario that did not pass or is incomplete. */
export function CartBottleneckNotice({ graph, evaluation }: { graph: CartGraph; evaluation: CartEvaluation }) {
  const groups = evaluation.cases
    .filter((item) => !item.complete || !cartCasePassed(evaluation, item.id))
    .map((item) => ({
      caseId: item.id,
      sentences: cartBottlenecks(graph, item.observation).map(cartBottleneckSentence),
    }))
    .filter((group) => group.sentences.length > 0);
  if (groups.length === 0) return null;
  return (
    <section className="cart-bottleneck" aria-labelledby="cart-bottleneck-title">
      <h3 id="cart-bottleneck-title">Overloaded components</h3>
      <p className="cart-bottleneck__intro">
        Measured queue waits during the run. A request that waits here is slow everywhere downstream. A wait can also be harmless if the affected requests still meet their targets.
      </p>
      {groups.map((group) => {
        const shown = group.sentences.slice(0, NOTICE_LIMIT);
        const hidden = group.sentences.length - shown.length;
        return (
          <div key={group.caseId} className="cart-bottleneck__case">
            <h4>{cartCaseLabel(group.caseId)}</h4>
            <ul>
              {shown.map((sentence) => (
                <li key={sentence}>{sentence}</li>
              ))}
            </ul>
            {hidden > 0 ? <p className="cart-bottleneck__more">{`+ ${hidden} more in Component resources`}</p> : null}
          </div>
        );
      })}
    </section>
  );
}
