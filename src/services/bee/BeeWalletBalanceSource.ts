import { Wallet } from '@teamgosh/bee-sdk';
import type { MamaBoardLevelSource } from '../../shared/wallets';
import type {
  BeeSdkGatewayContract,
  BeeSdkOwnedResource,
  BeeSdkResourceOwner,
} from './contracts';

const NACKL_CURRENCY_ID = '1';
const SHELL_CURRENCY_ID = '2';
const USDC_CURRENCY_ID = '3';

interface NativeBalanceResult extends BeeSdkOwnedResource {
  readonly ecc: Readonly<Record<string, string>>;
  readonly popitgame: Readonly<Record<string, string>>;
}

interface NativeWalletReader extends BeeSdkOwnedResource {
  get_multifactor_balances(input: {
    readonly multifactor_address: string;
  }): Promise<NativeBalanceResult>;
  get_miner_address(input: {
    readonly multifactor_address: string;
  }): Promise<string>;
}

type NativeWalletFactory = (
  endpoints: readonly string[],
  apiUrl: string,
  appId: string,
) => NativeWalletReader;

type MamaBoardContractReader = (
  endpoint: string,
  minerAddress: string,
) => Promise<number | null>;

/**
 * Read-only Bee wallet balance adapter. It owns one native Wallet resource and
 * never controls wallet onboarding or mining lifecycle.
 */
export class BeeWalletBalanceSource implements MamaBoardLevelSource {
  #wallet: NativeWalletReader | null = null;

  constructor(
    private readonly gateway: BeeSdkGatewayContract & BeeSdkResourceOwner,
    private readonly configuration: Readonly<{
      endpoints: readonly string[];
      mamaBoardEndpoint?: string;
      apiUrl: string;
      appId: string;
    }>,
    private readonly createWallet: NativeWalletFactory = (
      endpoints,
      apiUrl,
      appId,
    ) => new Wallet([...endpoints], null, apiUrl, appId),
    private readonly readContract: MamaBoardContractReader =
      readMamaBoardContract,
  ) {}

  async synchronize(_walletId: string, walletAddress: string) {
    await this.gateway.initialize();
    const wallet = this.#wallet ?? this.#createOwnedWallet();
    const result = await wallet.get_multifactor_balances({
      multifactor_address: walletAddress,
    });

    try {
      return Object.freeze({
        nacklLockedRaw: result.popitgame[NACKL_CURRENCY_ID] ?? '0',
        nacklAvailableRaw: result.ecc[NACKL_CURRENCY_ID] ?? '0',
        shellRaw: result.ecc[SHELL_CURRENCY_ID] ?? '0',
        usdcRaw: result.ecc[USDC_CURRENCY_ID] ?? '0',
      });
    } finally {
      result.free();
    }
  }

  async readMamaBoardLevel(
    _walletId: string,
    walletAddress: string,
  ): Promise<number | null> {
    await this.gateway.initialize();
    const wallet = this.#wallet ?? this.#createOwnedWallet();
    const minerAddress = await wallet.get_miner_address({
      multifactor_address: walletAddress,
    });
    const endpoint =
      this.configuration.mamaBoardEndpoint ?? this.configuration.endpoints[0];

    if (!endpoint) {
      return null;
    }

    return normalizeMamaBoardLevel(
      await this.readContract(endpoint, minerAddress),
    );
  }

  #createOwnedWallet(): NativeWalletReader {
    const wallet = this.gateway.ownResource(
      this.createWallet(
        this.configuration.endpoints,
        this.configuration.apiUrl,
        this.configuration.appId,
      ),
    );
    this.#wallet = wallet;
    return wallet;
  }
}

async function readMamaBoardContract(
  endpoint: string,
  minerAddress: string,
): Promise<number | null> {
  const bridge =
    typeof window === 'undefined' ? undefined : window.minerCoreApp?.mamaBoard;

  if (!bridge) {
    return null;
  }

  return bridge.readOnChain(endpoint, minerAddress);
}

function normalizeMamaBoardLevel(value: number | null): number | null {
  return value !== null &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 72
    ? value
    : null;
}
