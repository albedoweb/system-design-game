import { useState } from 'react';

import { Button } from '../../ui/Button';
import { Modal } from '../../ui/Modal';
import { CartSimulationGuide } from './CartSimulationGuide';

/** The brief explains the player goal; implementation details are in the guide. */
export function CartBriefing() {
  const [guideOpen, setGuideOpen] = useState(false);
  return (
    <div className="cart-briefing">
      <header className="cart-briefing__head">
        <h2>One cart, anywhere</h2>
        <p>
          Build a shopping cart for customers in San Francisco, Frankfurt and Tokyo.
          Place your services in the right regions so everyday shopping stays fast,
          stays within budget, and never sells more stock than you have.
        </p>
      </header>
      <section>
        <h3>Requirements</h3>
        <ul className="cart-briefing__list">
          <li><strong>Normal shopping.</strong> Serve everyday traffic from all three regions. In each region, save 95% of cart edits in under 50 ms and read carts within 500 ms for 95% of requests, with at least 99% of requests succeeding.</li>
          <li><strong>One cart everywhere.</strong> A customer can change the same cart from any region. A read is complete only if the Application reads every storage that receives cart changes — so connect each Application to storage in all three regions, or share one storage between them.</li>
          <li><strong>Shopping Rush.</strong> The same traffic doubles from 20 s to 60 s. The same per-region latency, success and safety requirements apply, and this scenario sets the cost score.</li>
          <li><strong>Safe checkout (both scenarios).</strong> Buy the whole basket or nothing. Never oversell or charge stock twice on a retry. Complete 95% of checkouts within 750 ms, with at least 99% succeeding.</li>
          <li><strong>Budget.</strong> The Rush cost must stay at or below 6 credits/hour; cheaper qualifying designs score better.</li>
        </ul>
        <p className="cart-briefing__note">
          Nothing fails in either scenario: no links go down and no caches are cleared.
          Each run measures 101 s of traffic, then up to 10 s for in-flight requests to
          finish. Cost is charged for the 101 s window.
        </p>
      </section>
      <section>
        <h3>Build and test</h3>
        <p>
          Open Build to add components. Place an Application in each region, storage for
          carts, and one Inventory service, then connect them with paths and buy a circuit
          for every region pair you use. Tick every storage under Read targets in each Application's Properties.
        </p>
        <p>
          The test run covers exactly two scenarios: Normal shopping and Shopping Rush.
          Pass both, then reduce cost: cheaper qualifying designs score better. A missing
          or unfinished scenario withholds the score.
        </p>
      </section>
      <Button variant="ghost" onClick={() => setGuideOpen(true)}>How simulation works →</Button>
      {guideOpen ? (
        <Modal title="How simulation works" onClose={() => setGuideOpen(false)}>
          <div style={{ maxHeight: '70vh', overflowY: 'auto' }}><CartSimulationGuide /></div>
        </Modal>
      ) : null}
    </div>
  );
}
