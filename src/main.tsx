import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createMinerApplication } from './application';
import { minerProductionConfigurationFromEnvironment } from './application/productionConfiguration';
import { App } from './ui/App';
import './ui/styles.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Application root element was not found.');
}

async function bootstrap(): Promise<void> {
  const applicationPromise = createMinerApplication({
    configuration: minerProductionConfigurationFromEnvironment(
      import.meta.env,
      window.location.origin,
    ),
  });
  let unsubscribeFromShutdown: () => void = () => undefined;
  unsubscribeFromShutdown =
    window.minerCoreApp?.lifecycle.onShutdownRequested(async () => {
      try {
        const application = await applicationPromise;
        await application.dispose();
      } finally {
        unsubscribeFromShutdown();
      }
    }) ?? unsubscribeFromShutdown;
  const application = await applicationPromise;

  createRoot(root!).render(
    <StrictMode>
      <App application={application} />
    </StrictMode>,
  );
}

void bootstrap().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : 'Application initialization failed.';
  root.textContent = `Core Miner could not start: ${message}`;
});
