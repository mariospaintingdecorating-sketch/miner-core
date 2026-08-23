import { useEffect, useRef, useState } from 'react';
import type {
  MinerApplication,
  MinerOperatorState,
  RuntimeDiagnostic,
  RuntimePresentationUpdate,
  RuntimePresentationState,
  SystemMetricsSnapshot,
  WalletPresentation,
  WalletPresentationUpdate,
  WalletFinancialOverview,
  WalletRuntimePresentationStates,
} from '../../application';
import {
  recordRuntimeUpdate,
  recordWalletProjection,
  rendererPresentationMetrics,
  trackPresentationSubscription,
} from '../presentationMetrics';

const EMPTY_DIAGNOSTICS: readonly RuntimeDiagnostic[] = Object.freeze([]);
const RENDERER_METRICS_LOG_INTERVAL_MS = 5 * 60 * 1_000;

export function useMinerPresentation(
  application: MinerApplication,
  diagnosticsEnabled = false,
): {
  readonly runtimeState: RuntimePresentationState;
  readonly runtimeStates: WalletRuntimePresentationStates;
  readonly diagnostics: readonly RuntimeDiagnostic[];
  readonly wallets: readonly WalletPresentation[];
  readonly systemMetrics: Readonly<SystemMetricsSnapshot>;
  readonly operatorState: Readonly<MinerOperatorState>;
  readonly financialOverview: Readonly<WalletFinancialOverview>;
} {
  const [runtimeState, setRuntimeState] = useState<RuntimePresentationState>(() =>
    application.getCurrentRuntimeState(),
  );
  const [runtimeStates, setRuntimeStates] = useState<WalletRuntimePresentationStates>(
    () => application.getRuntimeStates(),
  );
  const [diagnostics, setDiagnostics] = useState<readonly RuntimeDiagnostic[]>(
    EMPTY_DIAGNOSTICS,
  );
  const [wallets, setWallets] = useState<readonly WalletPresentation[]>(() =>
    application.getWallets(),
  );
  const [systemMetrics, setSystemMetrics] = useState<Readonly<SystemMetricsSnapshot>>(
    () => application.getSystemMetrics(),
  );
  const [financialOverview, setFinancialOverview] = useState<
    Readonly<WalletFinancialOverview>
  >(() => application.getFinancialOverview());
  const [operatorState, setOperatorState] = useState<Readonly<MinerOperatorState>>(
    () => application.getOperatorState(),
  );
  const operatorRuntimeStatus = useRef(runtimeState.runtimeStatus);

  useEffect(
    () => {
      return subscribeToRuntimePresentation(
        application,
        (update) => {
          setRuntimeStates((current) =>
            mergeRuntimePresentationUpdate(current, update),
          );
          setRuntimeState((current) =>
            mergeCurrentRuntimePresentation(current, update),
          );
          const state = update.currentRuntimeState;
          if (
            state &&
            operatorRuntimeStatus.current !== state.runtimeStatus
          ) {
            operatorRuntimeStatus.current = state.runtimeStatus;
            setOperatorState(application.getOperatorState());
          }
        },
      );
    },
    [application],
  );

  useEffect(() => {
    if (!diagnosticsEnabled) {
      setDiagnostics(EMPTY_DIAGNOSTICS);
      return;
    }

    const releaseSubscription = import.meta.env.DEV
      ? trackPresentationSubscription()
      : () => undefined;
    const unsubscribe = application.subscribeToDiagnostics(setDiagnostics);
    return () => {
      unsubscribe();
      releaseSubscription();
    };
  }, [application, diagnosticsEnabled]);

  useEffect(
    () => {
      const releaseSubscription = import.meta.env.DEV
        ? trackPresentationSubscription()
        : () => undefined;
      const unsubscribe = application.subscribeToWalletUpdates((update) => {
        if (import.meta.env.DEV) {
          recordWalletProjection(update.wallets);
        }
        setWallets((current) =>
          mergeWalletPresentationUpdate(current, update),
        );
        if (update.financialChanged) {
          setFinancialOverview(application.getFinancialOverview());
        }
        setOperatorState(application.getOperatorState());
      });

      return () => {
        unsubscribe();
        releaseSubscription();
      };
    },
    [application],
  );

  useEffect(
    () => {
      const releaseSubscription = import.meta.env.DEV
        ? trackPresentationSubscription()
        : () => undefined;
      const unsubscribe = application.subscribeToSystemMetrics(setSystemMetrics);
      return () => {
        unsubscribe();
        releaseSubscription();
      };
    },
    [application],
  );

  useEffect(() => {
    if (!import.meta.env.DEV) {
      return;
    }

    const timer = globalThis.setInterval(() => {
      console.info(
        `[Core Miner renderer] ${JSON.stringify(rendererPresentationMetrics())}`,
      );
    }, RENDERER_METRICS_LOG_INTERVAL_MS);
    return () => globalThis.clearInterval(timer);
  }, []);

  return {
    runtimeState,
    runtimeStates,
    diagnostics,
    wallets,
    systemMetrics,
    operatorState,
    financialOverview,
  };
}

export function subscribeToRuntimePresentation(
  application: Pick<MinerApplication, 'subscribeToRuntimeUpdates'>,
  listener: (update: Readonly<RuntimePresentationUpdate>) => void,
): () => void {
  const releaseSubscription = import.meta.env.DEV
    ? trackPresentationSubscription()
    : () => undefined;
  const unsubscribe = application.subscribeToRuntimeUpdates((update) => {
    if (import.meta.env.DEV) {
      recordRuntimeUpdate();
    }
    listener(update);
  });
  let active = true;

  return () => {
    if (!active) {
      return;
    }
    active = false;
    unsubscribe();
    releaseSubscription();
  };
}

export function mergeRuntimePresentationUpdate(
  current: WalletRuntimePresentationStates,
  update: Readonly<RuntimePresentationUpdate>,
): WalletRuntimePresentationStates {
  if (update.scope === 'canonical') {
    return current;
  }

  if (update.scope === 'all') {
    return update.runtimeStates;
  }

  const next = new Map(current);
  for (const [walletId, state] of update.runtimeStates) {
    next.set(walletId, state);
  }
  return next;
}

export function mergeCurrentRuntimePresentation(
  current: Readonly<RuntimePresentationState>,
  update: Readonly<RuntimePresentationUpdate>,
): RuntimePresentationState {
  if (update.scope === 'canonical' && update.canonicalEpochs) {
    return Object.freeze({
      ...current,
      epochs: update.canonicalEpochs,
    });
  }

  if (!update.currentRuntimeState) {
    return current;
  }

  return Object.freeze({
    ...update.currentRuntimeState,
    epochs: current.epochs,
  });
}

export function mergeWalletPresentationUpdate(
  current: readonly WalletPresentation[],
  update: Readonly<WalletPresentationUpdate>,
): readonly WalletPresentation[] {
  if (update.scope === 'all') {
    return update.wallets;
  }

  const wallet = update.wallets[0];
  if (!wallet) {
    return current;
  }
  const index = current.findIndex(({ id }) => id === wallet.id);
  if (index < 0) {
    return current;
  }

  const next = [...current];
  next[index] = wallet;
  return Object.freeze(next);
}
