import { describe, expect, it, vi } from 'vitest';
import { BeeWalletBalanceSource } from './BeeWalletBalanceSource';

describe('BeeWalletBalanceSource', () => {
  it('maps active wallet currency ownership and frees each result', async () => {
    const freeResult = vi.fn();
    const reader = {
      free: vi.fn(),
      get_miner_address: vi.fn(async () =>
        '0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      ),
      get_multifactor_balances: vi.fn(async () => ({
        ecc: { '1': '2000000000', '2': '3000000000', '3': '4000000000' },
        popitgame: { '1': '1500000000' },
        free: freeResult,
      })),
    };
    const gateway = {
      initialize: vi.fn(async () => undefined),
      readiness: vi.fn(() => ({ status: 'ready' as const, version: null, failure: null })),
      ownResource: vi.fn((resource) => resource),
      releaseResource: vi.fn(),
      dispose: vi.fn(async () => undefined),
    };
    const createWallet = vi.fn(() => reader);
    const source = new BeeWalletBalanceSource(
      gateway,
      { endpoints: ['https://node.example'], apiUrl: 'https://api.example', appId: 'app' },
      createWallet,
    );

    await expect(source.synchronize('wallet-a', '0:public-address')).resolves.toEqual({
      nacklLockedRaw: '1500000000',
      nacklAvailableRaw: '2000000000',
      shellRaw: '3000000000',
      usdcRaw: '4000000000',
    });
    await source.synchronize('wallet-b', '0:other-public-address');

    expect(createWallet).toHaveBeenCalledOnce();
    expect(gateway.ownResource).toHaveBeenCalledOnce();
    expect(reader.get_multifactor_balances).toHaveBeenNthCalledWith(1, {
      multifactor_address: '0:public-address',
    });
    expect(freeResult).toHaveBeenCalledTimes(2);
  });

  it('reads getDetails mbiCur through the Electron contract boundary', async () => {
    const reader = {
      free: vi.fn(),
      get_multifactor_balances: vi.fn(),
      get_miner_address: vi.fn(async () =>
        '0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      ),
    };
    const gateway = {
      initialize: vi.fn(async () => undefined),
      readiness: vi.fn(() => ({ status: 'ready' as const, version: null, failure: null })),
      ownResource: vi.fn((resource) => resource),
      releaseResource: vi.fn(),
      dispose: vi.fn(async () => undefined),
    };
    const readContract = vi.fn(async () => 72);
    const source = new BeeWalletBalanceSource(
      gateway,
      {
        endpoints: ['http://localhost:5173'],
        mamaBoardEndpoint: 'https://node.example',
        apiUrl: 'https://api.example',
        appId: 'app',
      },
      () => reader,
      readContract,
    );

    await expect(
      source.readMamaBoardLevel('wallet-a', '0:public-address'),
    ).resolves.toBe(72);
    await expect(
      source.readMamaBoardLevel('wallet-readded', '0:public-address'),
    ).resolves.toBe(72);
    expect(reader.get_miner_address).toHaveBeenNthCalledWith(1, {
      multifactor_address: '0:public-address',
    });
    expect(reader.get_miner_address).toHaveBeenNthCalledWith(2, {
      multifactor_address: '0:public-address',
    });
    expect(readContract).toHaveBeenNthCalledWith(
      1,
      'https://node.example',
      '0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    expect(readContract).toHaveBeenNthCalledWith(
      2,
      'https://node.example',
      '0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
  });

  it('does not invent a MamaBoard level for unavailable or invalid data', async () => {
    const reader = {
      free: vi.fn(),
      get_multifactor_balances: vi.fn(),
      get_miner_address: vi.fn(async () =>
        '0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      ),
    };
    const gateway = {
      initialize: vi.fn(async () => undefined),
      readiness: vi.fn(() => ({ status: 'ready' as const, version: null, failure: null })),
      ownResource: vi.fn((resource) => resource),
      releaseResource: vi.fn(),
      dispose: vi.fn(async () => undefined),
    };
    const source = new BeeWalletBalanceSource(
      gateway,
      { endpoints: ['https://node.example'], apiUrl: 'https://api.example', appId: 'app' },
      () => reader,
      async () => 73,
    );

    await expect(
      source.readMamaBoardLevel('wallet-a', '0:public-address'),
    ).resolves.toBeNull();
  });
});
