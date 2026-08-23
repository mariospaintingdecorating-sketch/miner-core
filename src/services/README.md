# Services

Infrastructure-facing services belong here.

The Bee SDK integration lives under `bee/`. Its gateway owns WASM
initialization and explicit SDK resource disposal. Separate adapters implement
wallet approval, native Miner sessions, one-tap execution, settlement evidence,
and native reward synchronization. None controls Core lifecycle.

Production composition remains configuration-driven: endpoints, application
ID, wallet selection, settlement evidence, and confirmed reward evidence must
be supplied before live operations are enabled.
