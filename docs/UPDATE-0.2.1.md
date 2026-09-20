# Core Miner 0.2.1 beta

This update targets the Windows Electron application, not the Android or cloud projects.

- Stock wallet/connection SDK: @teamgosh/bee-sdk 5.1.1, registry archive SHA-256
  4846e07daf69c8d91aa54669e9956bd0cde725160d0d6cf021239fb28c1dac0e.
- Mining-only module: @msii/bee-miner 5.1.1-core.1, derived from official bee-engine
  commit 41ae0611b47256b06fc6dce9943e283e9e96851c, with the existing official
  exact-message QUEUE_OVERFLOW sender enabled. The hashing, signing and proof
  routines are not rewritten. This is NOT a byte-identical copy of a proprietary miner.
- Application authorization ID: 0x0000000000000000000000000000000000000000000000000000000000000030.
  The system contract partition remains MobileVerifiers (...0001).
- Legacy 0: account addresses are normalized at SDK boundaries. Existing stored
  records are preserved. Keys without matching authorization metadata require a
  successful on-chain read verification before they may enter the mining worker.
  This does not automatically authorize old keys for the new app or replace them.
- The first tap is delayed by 1720 ms; subsequent taps are paced without catch-up
  bursts; target 70, native computation window 126000 ms, minimum start window
  145000 ms. Admission is checked again after asynchronous dispatch/reads.
- Receipt, computed taps, session acceptance and reward remain distinct measures.
- QR approval read has a 180-second controller deadline. Late read results are
  freed instead of applied. This does not cancel a transaction already sent by a wallet.
- MamaBoard read sends the real system DApp ID separately from the account ID.

Keep a wallet backup before upgrade. The application identity and user-data directory
remain unchanged. No live keys or wallet state are included in build artifacts.
The installer is unsigned. Compilation and synthetic regression tests are NOT
confirmation of mainnet acceptance, performance or long-run Windows reliability.
