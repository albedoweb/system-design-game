import {
  CART_CANDIDATE_FAMILIES,
  CART_FIXED_RULES,
  CART_GATE_ROWS,
  CART_KEYBOARD_HELP,
} from './cart-meta';

/** English reference for the two scenarios, the requirements and the score. */
export function CartSimulationGuide() {
  return (
    <div className="cart-briefing">
      <header className="cart-briefing__head">
        <p className="cart-briefing__eyebrow">Reference</p>
        <h2>How simulation works</h2>
        <p>
          Build one shopping cart for customers in US West, EU Central and AP Northeast.
          Place components in regions, draw their paths, buy circuits between regions, and
          keep the design within budget.
        </p>
      </header>

      <section>
        <h3>Scenarios</h3>
        <ol className="cart-briefing__list cart-briefing__list--numbered">
          <li>
            <strong>Normal shopping:</strong> 600 requests/s across the three regions, with
            cart edits, reads and checkouts.
          </li>
          <li>
            <strong>Shopping Rush:</strong> the same traffic, doubled from 20 s to 60 s.
            This scenario sets the cost score.
          </li>
        </ol>
        <p className="cart-briefing__note">
          Nothing fails in either scenario: no links go down and no caches are cleared.
        </p>
      </section>

      <section>
        <h3>What is measured</h3>
        <p>
          Each run measures 101 s of traffic, then up to 10 s for in-flight requests to
          finish. Cost is charged for the 101 s window. Safety checks run throughout. A
          missing or unfinished scenario withholds the score.
        </p>
      </section>

      <section>
        <h3>Requirements</h3>
        <div className="cart-table-wrap">
          <table className="cart-table">
            <caption>Requirements for each scenario</caption>
            <thead>
              <tr>
                <th scope="col">Requirement</th>
                <th scope="col">Target</th>
                <th scope="col">Notes</th>
              </tr>
            </thead>
            <tbody>
              {CART_GATE_ROWS.map((row) => (
                <tr key={row.gate}>
                  <th scope="row">{row.gate}</th>
                  <td>{row.draft}</td>
                  <td>{row.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="cart-briefing__note">
          A design that misses a requirement in either scenario has no score, however
          cheap it is.
        </p>
      </section>

      <section>
        <h3>Components and paths</h3>
        <p>
          The starter contains only the three customer sources. Add one Application per
          region, at most one Cache, Durable journal and Cart store per region, and exactly
          one Inventory. Choose instances and S or M sizes, then draw the paths.
        </p>
        <p>
          A request path carries requests one way; a replication path delivers cart
          changes to a journal or cart store. Both must be drawn. Each region pair needs a
          purchased circuit at 2, 8 or 32 Mbit/s per direction before paths between them
          can run.
        </p>
        <ul className="cart-briefing__list">
          {CART_FIXED_RULES.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
        <p>Three starting ideas are worth testing. They are candidates, not promised passing designs:</p>
        <ul className="cart-briefing__list">
          {CART_CANDIDATE_FAMILIES.map((family) => (
            <li key={family}>{family}</li>
          ))}
        </ul>
      </section>

      <section>
        <h3>Reads need every region</h3>
        <p>
          A customer can change the same cart from any region, so a read is complete only
          when the Application reads every journal or store that any Application writes to.
          Replication paths and reading through another Application do not count in this
          level, and a checkout needs a complete read first.
        </p>
        <p>
          Separate regional storage makes cart changes fast locally, but every read crosses
          regions. One shared storage makes reads fast, but cart changes from distant
          regions are slow.
        </p>
      </section>

      <section>
        <h3>How the score works</h3>
        <p>
          Only designs that pass both scenarios are scored. Among them, the lowest Shopping
          Rush cost scores best. The game scores measured behaviour and cost, never a
          component name or layout.
        </p>
      </section>

      <section>
        <h3>Controls</h3>
        <ul className="cart-briefing__list">
          {CART_KEYBOARD_HELP.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p className="cart-briefing__note">
          Save and open designs as files, including their seed. Refresh and Reset return to
          the starter graph; the level never saves or restores a design automatically.
        </p>
      </section>
    </div>
  );
}
