# Storage

This layer defines persistence-only boundaries for settings, diagnostics
history, wallet configuration, and wallet-separated reward history. The
desktop adapter uses SQLite for structured data and an append-only, bounded
diagnostics file through the Electron preload boundary. Storage never controls
Core Engine lifecycle or owns live runtime state. Sensitive Bee connection and
mining credential payloads are passed through Electron `safeStorage`; SQLite
stores only the encrypted payload under an opaque reference.
