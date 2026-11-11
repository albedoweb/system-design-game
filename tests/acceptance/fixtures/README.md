# Acceptance fixtures

Small, tracked inputs used by `npm run acceptance`.

| File | Provenance |
| --- | --- |
| `cold-cache-cheap-pass.json` | `tests/calibration/cheap-pass.json` → `graph` member from the committed Cold Cache calibration fixture. |
| `cold-cache-overbudget.json` | `tests/calibration/overbudget.json` → `graph` member. |
| `invalid-graph.json` | Deliberately incomplete document used to check public rejection (missing nodes/edges). |

Parcel and Image Atlas acceptance inputs stay at their product paths
(`fixtures/parcel/...`, `fixtures/images/...`) so this test layer does not fork
product fixtures. Missing target fixtures are reported as a failure, never
skipped.

Image Atlas uses `fixtures/images/family-direct.json` for the full browser
qualification. `directory-direct.json` is a valid two-copy contract example
used only for save/import state checks; it is not a fault-tolerant pass witness.
