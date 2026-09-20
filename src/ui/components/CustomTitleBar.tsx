import { CORE_MINER_VERSION } from '../../application';
import { useEffect, useState } from 'react';
import logoUrl from '../../../assets/logo/msii-logo-ui.png';

type WindowControls = NonNullable<Window['minerCoreApp']>['windowControls'];

export interface CustomTitleBarProps {
  readonly controls?: WindowControls | null;
}

export function CustomTitleBar({ controls: providedControls }: CustomTitleBarProps = {}) {
  const controls = providedControls === undefined
    ? browserWindowControls()
    : providedControls ?? undefined;
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!controls) return;

    let mounted = true;
    const unsubscribe = controls.onMaximizedChanged(setMaximized);
    void controls.isMaximized().then((value) => {
      if (mounted) setMaximized(value);
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [controls]);

  // Renderer HMR can update before Electron main/preload restarts. Hiding the
  // custom chrome in that stale state prevents two competing title bars.
  if (!controls) return null;

  return (
    <header className="custom-title-bar" data-testid="custom-title-bar">
      <div className="title-bar-identity">
        <img src={logoUrl} alt="" aria-hidden="true" width="20" height="20" />
        <strong>Core Miner {CORE_MINER_VERSION}</strong>
      </div>
      <div className="window-controls" aria-label="Window controls">
        <button
          type="button"
          aria-label="Minimize window"
          onClick={() => void controls.minimize()}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
            <path d="M2 8.5h8" />
          </svg>
        </button>
        <button
          type="button"
          aria-label={maximized ? 'Restore window' : 'Maximize window'}
          onClick={() => void controls.toggleMaximize()}
        >
          {maximized ? <RestoreIcon /> : <MaximizeIcon />}
        </button>
        <button
          type="button"
          className="window-control-close"
          aria-label="Close window"
          onClick={() => void controls.close()}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
            <path d="m2.5 2.5 7 7m0-7-7 7" />
          </svg>
        </button>
      </div>
    </header>
  );
}

function browserWindowControls(): WindowControls | undefined {
  return typeof window === 'undefined'
    ? undefined
    : window.minerCoreApp?.windowControls;
}

function MaximizeIcon() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <rect x="2.25" y="2.25" width="7.5" height="7.5" />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d="M4 3V2h6v6H9M2 4h6v6H2z" />
    </svg>
  );
}
