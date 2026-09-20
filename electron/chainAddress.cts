export const MOBILE_VERIFIERS_DAPP_ID = '1'.padStart(64, '0');
export function parseMinerContractAddress(value: unknown): Readonly<{ dappId: string; accountId: string; localAddress: string }> {
  if (typeof value !== 'string') throw new TypeError('Invalid Miner contract address.');
  const old = /^0:([0-9a-f]{64})$/i.exec(value);
  const current = /^([0-9a-f]{64})::([0-9a-f]{64})$/i.exec(value);
  const accountId = old?.[1] ?? current?.[2];
  const dappId = old ? MOBILE_VERIFIERS_DAPP_ID : current?.[1].toLowerCase();
  if (!accountId || dappId !== MOBILE_VERIFIERS_DAPP_ID) throw new TypeError('Invalid Miner contract partition.');
  return Object.freeze({ dappId, accountId: accountId.toLowerCase(), localAddress: `0:${accountId.toLowerCase()}` });
}
