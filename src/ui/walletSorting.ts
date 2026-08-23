import type { WalletPresentation } from '../application';

export function compareWalletsByMamaBoardLevel(
  left: Pick<WalletPresentation, 'id' | 'mamaBoardLevel' | 'name'>,
  right: Pick<WalletPresentation, 'id' | 'mamaBoardLevel' | 'name'>,
): number {
  if (left.mamaBoardLevel === null) {
    return right.mamaBoardLevel === null
      ? compareWalletIdentity(left, right)
      : 1;
  }

  if (right.mamaBoardLevel === null) {
    return -1;
  }

  return (
    right.mamaBoardLevel - left.mamaBoardLevel ||
    compareWalletIdentity(left, right)
  );
}

function compareWalletIdentity(
  left: Pick<WalletPresentation, 'id' | 'name'>,
  right: Pick<WalletPresentation, 'id' | 'name'>,
): number {
  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}
