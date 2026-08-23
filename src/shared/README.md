# Shared

Cross-layer contracts belong here, including wallet/reward identity and event
payloads. Event delivery uses a minimal synchronous publisher and observer with
no lifecycle control, timers, or background workers.

Reward amount discovery and blockchain confirmation remain undocumented. The
ledger accepts only concrete reward records supplied by a future integration
source; it never invents amounts or global totals. With persistence configured,
`reward-recorded` is emitted only after durable recording succeeds.
