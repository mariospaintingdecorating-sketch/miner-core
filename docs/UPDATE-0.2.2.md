# Core Miner 0.2.2 beta — wallet authorization repair

Scope: Windows desktop Core Miner, not the separate cloud or Android application.
The two supplied APKs are reference material only and are not bundled into Core.

## Changed

- Production wallet authorization uses the official Bee SDK 5.1.1 standalone
  `gen_mining_keys(app_id)` flow. One direct mining-key QR replaces the
  BeeConnect shared-session hello plus a separate `request_set_mining_keys` write.
- User supplies the exact existing AN Wallet account name and approves the QR
  with that account in AN Wallet. No recovery phrase or owner secret is requested.
- The official v2 deep link is validated to contain only `pubkey` and `app_id`.
  Pending private keys use the existing encrypted secure-reference store before
  QR display. Retry and application restart preserve the same request/key.
- Account discovery distinguishes the multifactor wallet address from the miner
  contract address. For official mainnet endpoints, name lookup can fall back to
  Shellnet/mainnet-cf. Final owner_public verification uses mining endpoints only.
- Ready requires verification of the expected public key for the intended app ID.
  Discovery, local generation and a displayed QR are NOT verification.
- Local observation is bounded to 180 seconds with bounded individual waits and
  single-flight reads. Pause interrupts local observation, not a submitted
  blockchain operation. Retrying continues the same saved authorization request.
- Old version-1 credentials can be checked without BeeConnect or generating new
  keys. A pending replacement does not erase previous credentials. Context
  mismatches are rejected rather than silently rotating keys.
- Add wallet starts QR generation automatically. The dedicated setup panel is
  reduced to account name, QR, automatic status and Pause/Resume; saved-key checks
  remain available. A long authorization no longer locks global UI controls.

## Unchanged

The mining controller, pacing, retry module, timers, stored wallet schema,
installer application identity/data directory, official Bee WASM, and derived
mining WASM are not updated by this repair. Authorization application ID remains:
`0x0000000000000000000000000000000000000000000000000000000000000030`.

## Evidence / limits

Automated tests use synthetic accounts/keys and mocked chain reads except a local
key/QR-generation check with the real pinned SDK. The Windows packaged UI test
uses an empty profile, blocked browser HTTP and a synthetic account. It checks
QR generation, Pause, retry, persistence across renderer restart, and refusal to
become Ready without network approval. It does NOT approve an actual wallet or
perform mainnet mining. An upgrade of a populated user profile remains untested.

Node v0.19.2 release notes discuss queue handling. They are not evidence that the
node caused this particular user's wallet onboarding failure. No secret-bearing
user logs were provided; a precise failure at the user's machine is unconfirmed.

The supplied Android 1.3.9 and msii 0.1.2 bundles both use standalone key-generation
and direct approval, unlike the previous Core onboarding flow. Their early-ready
behavior is not copied: authorization remains required before enabling mining.

Back up the local data privately, stop mining, close Core Miner, install the
update with existing data retained, and test authorization with one non-mining
account first. The installer is not Authenticode signed unless a separate
signature-verification report states otherwise.
