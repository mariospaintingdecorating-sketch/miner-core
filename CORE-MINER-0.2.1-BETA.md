# Core Miner 0.2.1 beta

Windows desktop update of source snapshot d730bbb02caa97e10b8ac162326ff61ded6c045d.
Installer: `Core Miner 0.2.1 beta setup.exe`. Not a cloud service or Android build.

## Implemented

- Pin `@teamgosh/bee-sdk` to 5.1.1 in manifest and lockfile. Verify the real packaged WASM SHA-256: `deb6f6ea9278f82fab58ed9167adb3cbf3644ecb73a5f7b71acac227a6797e95`.
- Public production configuration: mainnet.ackinacki.org and DApp `0x0000000000000000000000000000000000000000000000000000000000000030`. No access tokens in the build.
- Persist pending mining keys through encrypted storage before authorization. After an ambiguous request failure, check propagation of the same pending key rather than blindly resending or generating a replacement. A pending unconfirmed request can require explicit reconnection; it is not silently treated as success.
- Record the DApp and verification time on a credential only after the SDK propagation check succeeds. Legacy READY records without this context are restored as awaiting verification, retaining all records and secrets. No automatic on-chain key change or deletion.
- Production session: 70 taps, 1720 ms between taps, first tap after 1720 ms, 126000 ms session, complete admission window at least 145000 ms. Reject stale (>60 s), absent, and future clock timestamps; recheck after queued preparation/start waits.
- No catch-up bursts. Do not send new taps after the local session deadline. Keep SDK computation, delivery, acceptance and reward separate.
- Preparation retry budget is not reset by alternation between NETWORK and QUEUE errors. Keep existing fleet pressure controls and per-wallet lifecycle rather than copying global application reload behavior.
- Preserve package identity `com.msii.miner-core`, installed `%APPDATA%\Miner Core`, database name and default installer Keep profile choice.
- Public build version in UI; existing layout/logo retained. Exclude compiled test copies from test discovery.

## Source basis and deliberate limits

Official engine 5.1.1: https://github.com/gosh-sh/bee-engine/releases/tag/v5.1.1
Official prepared-message queue handling: https://github.com/gosh-sh/bee-engine/blob/v5.1.1/bee_infra/src/message_delivery.rs
Node release: https://github.com/ackinacki/ackinacki/releases/tag/v0.19.2
User-supplied PRO.13 functional audit (2026-09-19), especially F30/F31/F32/F33/F34/F49/F51.

The audit supports controller behavior, not complete equivalence to the custom PRO.13 WASM. This release uses the **official** npm SDK; it does not claim to copy custom root/proof retry internals, reproduce profitability, or remove network congestion. The SDK's prepared-message retry for wallet/Connect operations is not a proof that every miner transport path retries identically. Existing completion/reward/disposal ownership remains the Core implementation.

Tests use synthetic identities and mocked transports unless explicitly identified as a real packaged Windows launch. A packaged launch on an empty temporary profile is not a real-wallet authorization, mining, Windows sleep/resume, or installer-upgrade test. Keep a backup before updating. For legacy keys, try Verify propagation; if authorization for the new DApp is missing, a new wallet approval is required. Do not run the same mining identity simultaneously in another miner.
