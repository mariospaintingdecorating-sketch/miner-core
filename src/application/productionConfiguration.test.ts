import { describe, expect, it } from 'vitest';
import {
  minerProductionConfigurationFromEnvironment,
  resolveProductionConfiguration,
} from './productionConfiguration';

describe('production configuration', () => {
  it('keeps Bee on configured HTTPS while isolating the DEV canonical clock', () => {
    const input = minerProductionConfigurationFromEnvironment({
      DEV: true,
      VITE_MINER_CORE_BEE_ENDPOINTS: 'https://mainnet.example',
      VITE_MINER_CORE_BEE_APP_ID: 'operator-app-id',
    }, 'http://localhost:5173');

    const configuration = resolveProductionConfiguration(input).value;
    expect(configuration?.endpoints).toEqual(['https://mainnet.example']);
    expect(configuration?.canonicalEndpoint).toBe('http://[::1]:5173');
    expect(configuration?.mamaBoardEndpoint).toBe('https://mainnet.example');
    expect(new URL(configuration!.endpoints[0]!).protocol).toBe('https:');
  });

  it('keeps the operator-configured network base in production builds', () => {
    const input = minerProductionConfigurationFromEnvironment({
      DEV: false,
      VITE_MINER_CORE_BEE_ENDPOINTS: 'https://mainnet.example',
      VITE_MINER_CORE_BEE_APP_ID: 'operator-app-id',
    }, 'file://');

    const configuration = resolveProductionConfiguration(input).value;
    expect(configuration?.endpoints).toEqual(['https://mainnet.example']);
    expect(configuration?.canonicalEndpoint).toBe('https://mainnet.example');
    expect(configuration?.mamaBoardEndpoint).toBe('https://mainnet.example');
    expect(JSON.stringify(configuration)).not.toContain('localhost');
  });

  it('keeps an empty operator environment safely missing', () => {
    const input = minerProductionConfigurationFromEnvironment({});
    const resolution = resolveProductionConfiguration(input);

    expect(input).toBeUndefined();
    expect(resolution.value).toBeNull();
    expect(resolution.snapshot).toEqual({
      status: 'missing',
      code: 'production-configuration-missing',
      endpointCount: 0,
      appIdConfigured: false,
      maximumSessionDurationMs: 135_000,
    });
  });

  it('parses new Core Miner variables while exposing only a safe summary', () => {
    const input = minerProductionConfigurationFromEnvironment({
      VITE_MINER_CORE_BEE_ENDPOINTS:
        ' https://node-a.example , https://node-b.example ',
      VITE_MINER_CORE_BEE_APP_ID: ' operator-app-id ',
      VITE_MINER_CORE_BEE_API_URL: ' https://api.example ',
    });
    const resolution = resolveProductionConfiguration(input);

    expect(resolution.value).toEqual({
      endpoints: ['https://node-a.example', 'https://node-b.example'],
      canonicalEndpoint: 'https://node-a.example',
      mamaBoardEndpoint: 'https://node-a.example',
      appId: 'operator-app-id',
      apiUrl: 'https://api.example',
      maximumSessionDurationMs: 135_000,
    });
    expect(resolution.snapshot).toEqual({
      status: 'ready',
      code: 'production-configuration-ready',
      endpointCount: 2,
      appIdConfigured: true,
      maximumSessionDurationMs: 135_000,
    });
    expect(JSON.stringify(resolution.snapshot)).not.toContain(
      'https://node-a.example',
    );
    expect(JSON.stringify(resolution.snapshot)).not.toContain('operator-app-id');
  });

  it('parses legacy-compatible variables', () => {
    const input = minerProductionConfigurationFromEnvironment({
      VITE_ACKI_ENDPOINT:
        ' https://legacy-a.example , https://legacy-b.example ',
      VITE_ACKI_APP_ID: ' legacy-app-id ',
      VITE_ACKI_API_URL: ' https://legacy-api.example ',
    });
    const resolution = resolveProductionConfiguration(input);

    expect(resolution.value).toEqual({
      endpoints: ['https://legacy-a.example', 'https://legacy-b.example'],
      canonicalEndpoint: 'https://legacy-a.example',
      mamaBoardEndpoint: 'https://legacy-a.example',
      appId: 'legacy-app-id',
      apiUrl: 'https://legacy-api.example',
      maximumSessionDurationMs: 135_000,
    });
    expect(resolution.snapshot).toEqual({
      status: 'ready',
      code: 'production-configuration-ready',
      endpointCount: 2,
      appIdConfigured: true,
      maximumSessionDurationMs: 135_000,
    });
  });

  it('gives new Core Miner variables priority over compatible variables', () => {
    const input = minerProductionConfigurationFromEnvironment({
      VITE_MINER_CORE_BEE_ENDPOINTS: 'https://new.example',
      VITE_MINER_CORE_BEE_APP_ID: 'new-app-id',
      VITE_ACKI_ENDPOINT: 'https://legacy.example',
      VITE_ACKI_APP_ID: 'legacy-app-id',
      VITE_MINER_CORE_BEE_API_URL: 'https://new-api.example',
      VITE_ACKI_API_URL: 'https://legacy-api.example',
    });

    expect(resolveProductionConfiguration(input).value).toEqual({
      endpoints: ['https://new.example'],
      canonicalEndpoint: 'https://new.example',
      mamaBoardEndpoint: 'https://new.example',
      appId: 'new-app-id',
      apiUrl: 'https://new-api.example',
      maximumSessionDurationMs: 135_000,
    });
  });

  it('uses the default balance API when no override is configured', () => {
    const input = minerProductionConfigurationFromEnvironment({
      VITE_MINER_CORE_BEE_ENDPOINTS: 'https://node.example',
      VITE_MINER_CORE_BEE_APP_ID: 'operator-app-id',
    });

    expect(resolveProductionConfiguration(input).value).toEqual({
      endpoints: ['https://node.example'],
      canonicalEndpoint: 'https://node.example',
      mamaBoardEndpoint: 'https://node.example',
      appId: 'operator-app-id',
      apiUrl: 'https://app-backend.ackinacki.org/api',
      maximumSessionDurationMs: 135_000,
    });
  });

  it('reports malformed endpoint lists as invalid without exposing values', () => {
    const input = minerProductionConfigurationFromEnvironment({
      VITE_MINER_CORE_BEE_ENDPOINTS:
        'https://node.example,,https://node.example',
      VITE_MINER_CORE_BEE_APP_ID: 'operator-app-id',
    });
    const resolution = resolveProductionConfiguration(input);

    expect(resolution.value).toBeNull();
    expect(resolution.snapshot).toMatchObject({
      status: 'invalid',
      code: 'production-configuration-invalid',
      appIdConfigured: true,
    });
    expect(JSON.stringify(resolution.snapshot)).not.toContain(
      'https://node.example',
    );
    expect(JSON.stringify(resolution.snapshot)).not.toContain('operator-app-id');
  });
});
