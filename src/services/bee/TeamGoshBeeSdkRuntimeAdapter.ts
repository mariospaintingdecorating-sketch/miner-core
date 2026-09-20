import initializeBeeSdk from '@teamgosh/bee-sdk';
import beeSdkWasmUrl from '@teamgosh/bee-sdk/bee_sdk_bg.wasm?url';
import type { BeeSdkRuntimeAdapter } from './contracts';

/** Browser/WASM module adapter only. It performs no wallet or mining action. */
export class TeamGoshBeeSdkRuntimeAdapter implements BeeSdkRuntimeAdapter {
  async initialize(): Promise<void> {
    await initializeBeeSdk({ module_or_path: beeSdkWasmUrl });
  }

  version(): string {
    // Build-time pin is checked against package metadata and WASM SHA-256 in CI.
    return '5.1.1';
  }

  dispose(): void {
    // The module exposes no global teardown. Gateway-owned SDK objects are
    // released individually through their free() methods.
  }
}
