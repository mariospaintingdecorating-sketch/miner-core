import type { CanonicalChainStateProvider } from '../../application/CanonicalChainState';
import type {
  CanonicalMiniEpochSnapshot,
  CanonicalMiniEpochSource,
} from '../WalletMiningRuntime';

/** Shares the existing product provider; it creates no timer or polling loop. */
export class ProductCanonicalMiniEpochAdapter
  implements CanonicalMiniEpochSource
{
  constructor(
    private readonly canonical: Pick<
      CanonicalChainStateProvider,
      'snapshot' | 'subscribe'
    >,
  ) {}

  snapshot(): Readonly<CanonicalMiniEpochSnapshot> {
    const canonical = this.canonical.snapshot();
    return Object.freeze({
      miniEpoch: canonical.miniEpoch.id,
      remainingMs: canonical.miniEpoch.remainingMs,
      ...('updatedAt' in canonical ? {
        observedAtMs: canonical.updatedAt === null ? null : Date.parse(canonical.updatedAt),
      } : {}),
    });
  }

  subscribe(listener: () => void): () => void {
    return this.canonical.subscribe(listener);
  }
}
