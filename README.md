# Core Miner

Core Miner is an Electron desktop application with a React presentation layer
and an Application-owned boundary around the Core and Bee integrations.

## Requirements

- Node.js `^20.19.0` or `>=22.12.0`
- npm

## Fresh checkout

Install the locked dependencies once:

```powershell
npm ci
```

Then use the canonical one-command startup:

```powershell
npm start
```

`npm start` first builds the React renderer and Electron main/preload outputs,
then launches Electron. Build output is intentionally ignored by Git, so the
automatic prestart build is required for a fresh checkout.

For developer hot reload, use:

```powershell
npm run dev
```

## Bee configuration

Bee production configuration is optional at startup. With no `.env.local`, the
desktop still opens and the Wallets view reports the safe
`production-configuration-missing` blocker. Construction does not initialize
Bee, connect a wallet, create a mining session, or start mining.

For an explicitly authorized wallet-only operator test, copy `.env.example` to
`.env.local` and supply the authoritative values locally. Do not guess values,
commit `.env.local`, or place wallet keys or secrets in it.

Use the Core Miner names for new local configuration:

```text
VITE_MINER_CORE_BEE_ENDPOINTS=
VITE_MINER_CORE_BEE_APP_ID=
VITE_MINER_CORE_BEE_API_URL=
```

The API URL is an optional override for read-only wallet balance and
reward-delta analytics. When it is omitted, Core Miner uses its default balance
API: `https://app-backend.ackinacki.org/api`. For
migration compatibility, `VITE_ACKI_ENDPOINT`, `VITE_ACKI_APP_ID`, and
`VITE_ACKI_API_URL` are also accepted as fallbacks. When both forms are
configured, the corresponding Core Miner variable takes priority. Restart the
application after changing `.env.local` so Vite reloads the configuration.

## Validation

```powershell
npm run typecheck
npm test
npm run build
```

## Windows Beta installer

Build the local Windows x64 application directory without creating an
installer:

```powershell
npm run pack:win
```

Build the assisted NSIS installer:

```powershell
npm run dist:win
```

Artifacts are written to `release/`. The installer uses the stable Windows
identity `com.msii.miner-core`, installs `Core Miner` per machine, and creates a
Start menu shortcut. It does not configure or contact an update server.

Application files and operator data are deliberately separated. Program files
are installed under `C:\Program Files\Core Miner`, while wallets, encrypted
credential payloads, settings, SQLite history, and diagnostics remain under
`%APPDATA%\Miner Core`. Reinstalling or upgrading the application does not
delete that user-data directory. `npm run dev` uses the independent
`%APPDATA%\miner-core` profile; neither startup path copies or synchronizes data
with the other. Removing wallets or mining keys is always a separate,
explicit user-data operation.
