# Core Miner 0.2.3 beta — SDK address boundary repair

## Evidence and scope

Private user diagnostics exposed a repeated `Encode message / Invalid address` in
`ensure_mining_keys_propagated`, with a dApp-scoped address given to the raw ABI encoder.
The diagnostics include earlier connection attempts and a later paused direct flow;
the paused flow alone does not expose its last SDK read exception. User identifiers
and raw diagnostics are not included in this repository.

Kit 6.1.0 `contracts/src/account.rs` defines separate `address` (`0:<hex>`) and
`dapp_id` fields. Network routing and ABI address encoding are different contracts.
The previous Core adapters incorrectly passed `dapp_id::account_id` into both.

## Repair

- Retain canonical scoped identities in storage. Convert only at the SDK boundary
  with `mobileAbiAddress`, accepting MobileVerifiers only and rejecting other partitions.
- Repair direct authorization, saved-key verification, wallet balance/MamaBoard reads,
  renderer Miner construction and Electron utility-process Miner construction.
- Retain application authorization ID 0x...0030. System contract routing stays ...0001.
- No new key generation, deletion or schema migration is needed for saved requests.
- After a transport failure, verification may read the other official mainnet endpoint;
  Shellnet is never used to verify authorization. Custom networks are not redirected.
- Preserve a safe diagnostic category for address-encoding errors, network failures and
  timeouts, without raw SDK errors or private payloads. Address errors fail immediately.
- Pausing verification is informational rather than an SDK failure in the activity log.
- The QR panel says it is waiting for on-chain key confirmation, not another wallet click.

## Unchanged

Official Bee SDK 5.1.1 and derived mining WASM 5.1.1-core.1 are unchanged binaries.
No changes to tap pacing, proof generation, session scheduling or mining retry policy.
One mining utility boundary changes the address representation passed to `Miner.new`.
Installer app ID and data directory are unchanged. Do not select the reset-data option.

## Validation limits

A synthetic active account BOC reproduces the original address-encoding failure in
the real pinned SDK. Raw ABI spelling reaches the TVM execution step; the deliberately
non-Miner fixture must still fail, and is never evidence of authorization success.
Additional boundary and controller tests use synthetic identities/mocked reads.
No real account approval, signed mainnet transaction or mining is performed by CI.
Actual results and counts are in the generated CI reports, not assumed by this note.
