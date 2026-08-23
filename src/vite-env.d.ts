/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly VITE_MINER_CORE_BEE_ENDPOINTS?: string;
  readonly VITE_MINER_CORE_BEE_APP_ID?: string;
  readonly VITE_MINER_CORE_BEE_API_URL?: string;
  readonly VITE_ACKI_ENDPOINT?: string;
  readonly VITE_ACKI_APP_ID?: string;
  readonly VITE_ACKI_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  readonly minerCoreApp?: {
    readonly platform: string;
    readonly versions: {
      readonly chrome: string;
      readonly electron: string;
      readonly node: string;
    };
    readonly walletApp: {
      open(
        walletId: string,
        deepLink: string,
      ): Promise<'adb_success' | 'fallback_required'>;
    };
    readonly mamaBoard: {
      readOnChain(endpoint: string, minerAddress: string): Promise<number | null>;
    };
    readonly observability: {
      systemMetrics(): Promise<unknown>;
      exportDiagnostics(bundle: unknown): Promise<unknown>;
    };
    readonly beeMining: {
      request(request: unknown): Promise<unknown>;
      onCallback(listener: (message: unknown) => void): () => void;
    };
    readonly lifecycle: {
      onShutdownRequested(listener: () => void | Promise<void>): () => void;
    };
    readonly system: {
      shutdownComputer(): Promise<
        'requested' | 'unsupported' | 'failed' | 'busy'
      >;
    };
    readonly windowControls: {
      minimize(): Promise<void>;
      toggleMaximize(): Promise<void>;
      close(): Promise<void>;
      isMaximized(): Promise<boolean>;
      onMaximizedChanged(listener: (maximized: boolean) => void): () => void;
    };
  };
}
