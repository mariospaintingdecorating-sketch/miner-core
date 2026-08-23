# Application layer

The Application Layer is the only UI-facing boundary to Core Engine.

It exposes mining commands, read-only presentation snapshots, translated
lifecycle events, bounded runtime diagnostics, and wallet-separated wallet and
reward projections. It does not own mining, settlement, boundary, scheduler,
or recovery behavior.

Wallet registration and removal are persistence-backed Application commands.
They change wallet metadata only and never call mining lifecycle operations.
Reward presentation is restored from wallet-scoped history; reward discovery
and amount calculation remain external integration concerns.
