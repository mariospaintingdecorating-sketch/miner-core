import { parseMinerContractAddress } from './chainAddress.cjs';
import { TonClient } from '@eversdk/core';
import { libNode } from '@eversdk/lib-node';

if (process.versions.electron) {
  throw new Error('MamaBoard worker must run under system Node.');
}

const MINER_DETAILS_ABI = {
  'ABI version': 2,
  version: '2.4',
  header: ['pubkey', 'time', 'expire'],
  functions: [
    {
      name: 'getDetails',
      inputs: [],
      outputs: [
        { name: 'mobileVerifiersContractGameRoot', type: 'address' },
        { name: 'owner', type: 'address' },
        { name: 'popitGame', type: 'address' },
        { name: 'boost', type: 'address' },
        { name: 'mbiCur', type: 'optional(uint64)' },
        { name: 'owner_pubkey', type: 'map(uint256,uint256)' },
        { name: 'epochStart', type: 'uint64' },
        { name: 'epochStartOld', type: 'uint64' },
        { name: 'oldTaps', type: 'uint128[]' },
        { name: 'oldTapsSize', type: 'uint128' },
        { name: 'oldMbiCurTaps', type: 'uint64[]' },
        { name: 'taps', type: 'uint128[]' },
        { name: 'mbiCurTaps', type: 'uint64[]' },
        { name: 'tapsSize', type: 'uint128' },
        { name: 'tapSum', type: 'uint128' },
        { name: 'modifiedTapSum', type: 'uint128' },
        { name: 'miningDurSum', type: 'uint128' },
        { name: 'epochBigStart', type: 'uint64' },
        { name: 'seed', type: 'uint256' },
        { name: 'seedNext', type: 'uint256' },
        { name: 'commitData', type: 'optional(bytes)' },
        {
          name: 'commitInterval',
          type: 'optional(tuple)',
          components: [
            {
              name: 'value0',
              type: 'tuple',
              components: [
                { name: 'first', type: 'uint64' },
                { name: 'second', type: 'uint64' },
              ],
            },
            {
              name: 'value1',
              type: 'tuple',
              components: [
                { name: 'first', type: 'uint64' },
                { name: 'second', type: 'uint64' },
              ],
            },
          ],
        },
        { name: 'easyComplexity', type: 'uint32' },
        { name: 'hardComplexity', type: 'uint32' },
      ],
    },
  ],
  events: [],
  data: [],
};

const ACCOUNT_QUERY = `query AccountInfo($accountId: String!, $dappId: String!) {
  blockchain {
    account(account_id: $accountId, dapp_id: $dappId) {
      info { boc }
    }
  }
}`;

TonClient.useBinaryLibrary(libNode);

process.once('message', (message: unknown) => {
  void handleMessage(message);
});

async function handleMessage(message: unknown): Promise<void> {
  let client: TonClient | null = null;

  try {
    if (!isReadRequest(message)) {
      throw new TypeError('Invalid MamaBoard read request.');
    }

    const endpoint = validateEndpoint(message.endpoint);
    const minerAddress = validateMinerAddress(message.minerAddress);
    const identity = parseMinerContractAddress(minerAddress);
    client = new TonClient({ network: { endpoints: [endpoint] } });
    const response = await client.net.query({
      query: ACCOUNT_QUERY,
      variables: { accountId: identity.accountId, dappId: identity.dappId },
    });
    const result = asRecord(response.result);
    const data = asRecord(result?.data);
    const blockchain = asRecord(data?.blockchain);
    const account = asRecord(blockchain?.account);
    const info = asRecord(account?.info);

    if (typeof info?.boc !== 'string' || info.boc.length === 0) {
      throw new Error('MamaBoard account BOC is unavailable.');
    }

    const abi = {
      type: 'Contract',
      value: createEversdkCompatibleAbi(),
    } as const;
    const encoded = await client.abi.encode_message({
      abi,
      address: identity.localAddress,
      signer: { type: 'None' },
      call_set: { function_name: 'getDetails', input: {} },
    });
    const executed = await client.tvm.run_tvm({
      message: encoded.message,
      account: info.boc,
      abi,
    });
    const output = asRecord(executed.decoded?.output);
    const level = normalizeLevel(unwrapOptional(output?.mbiCur));

    process.send?.({ ok: true, level });
  } catch {
    process.send?.({ ok: false });
  } finally {
    try {
      await client?.close();
    } catch {
      // The one-shot metadata worker is already terminating.
    }
    process.disconnect?.();
  }
}

function createEversdkCompatibleAbi(): typeof MINER_DETAILS_ABI {
  return {
    ...MINER_DETAILS_ABI,
    // Ever SDK 1.34 accepts the canonical read-only getDetails projection at 2.2.
    version: '2.2',
  };
}

function isReadRequest(
  value: unknown,
): value is Readonly<{ endpoint: string; minerAddress: string }> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'endpoint' in value &&
    typeof value.endpoint === 'string' &&
    'minerAddress' in value &&
    typeof value.minerAddress === 'string'
  );
}

function validateEndpoint(value: string): string {
  const endpoint = new URL(value);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) {
    throw new TypeError('Invalid MamaBoard endpoint.');
  }
  return endpoint.toString();
}

function validateMinerAddress(value: string): string {
  parseMinerContractAddress(value);
  return value as string;
}

function unwrapOptional(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  const record = asRecord(value);
  if (record && 'value0' in record) {
    return unwrapOptional(record.value0);
  }
  if (record && 'Some' in record) {
    return unwrapOptional(record.Some);
  }
  return value;
}

function normalizeLevel(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const level = Number(value);
  return Number.isInteger(level) && level >= 0 && level <= 72 ? level : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}
