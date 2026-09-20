export interface MinerProductionConfigurationInput {
  readonly endpoints?: readonly string[];
  readonly canonicalEndpoint?: string;
  readonly mamaBoardEndpoint?: string;
  readonly appId?: string;
  readonly apiUrl?: string;
  readonly maximumSessionDurationMs?: number;
}

export interface MinerProductionConfigurationEnvironment {
  readonly DEV?: boolean;
  readonly VITE_MINER_CORE_BEE_ENDPOINTS?: string;
  readonly VITE_MINER_CORE_BEE_APP_ID?: string;
  readonly VITE_ACKI_ENDPOINT?: string;
  readonly VITE_ACKI_APP_ID?: string;
  readonly VITE_MINER_CORE_BEE_API_URL?: string;
  readonly VITE_ACKI_API_URL?: string;
}

export type ProductionConfigurationStatus = 'ready' | 'missing' | 'invalid';

export interface ProductionConfigurationSnapshot {
  readonly status: ProductionConfigurationStatus;
  readonly code:
    | 'production-configuration-ready'
    | 'production-configuration-missing'
    | 'production-configuration-invalid';
  readonly endpointCount: number;
  readonly appIdConfigured: boolean;
  readonly maximumSessionDurationMs: number;
}

export interface ResolvedProductionConfiguration {
  readonly endpoints: readonly string[];
  readonly canonicalEndpoint: string;
  readonly mamaBoardEndpoint: string;
  readonly appId: string;
  readonly maximumSessionDurationMs: number;
  readonly apiUrl: string;
}

export interface ProductionConfigurationResolution {
  readonly snapshot: Readonly<ProductionConfigurationSnapshot>;
  readonly value: Readonly<ResolvedProductionConfiguration> | null;
}

const DEFAULT_MAXIMUM_SESSION_DURATION_MS = 126_000;
const MAXIMUM_ALLOWED_SESSION_DURATION_MS = 330_000;
const DEFAULT_BEE_API_URL = 'https://app-backend.ackinacki.org/api';

export function minerProductionConfigurationFromEnvironment(
  environment: MinerProductionConfigurationEnvironment,
  rendererOrigin?: string,
): Readonly<MinerProductionConfigurationInput> | undefined {
  const configuredEndpointList =
    environment.VITE_MINER_CORE_BEE_ENDPOINTS?.trim() ||
    environment.VITE_ACKI_ENDPOINT?.trim();
  const configuredPrimaryEndpoint = configuredEndpointList
    ?.split(',')[0]
    ?.trim();
  const appId =
    environment.VITE_MINER_CORE_BEE_APP_ID?.trim() ||
    environment.VITE_ACKI_APP_ID?.trim();
  const apiUrl =
    environment.VITE_MINER_CORE_BEE_API_URL?.trim() ||
    environment.VITE_ACKI_API_URL?.trim();

  if (!configuredEndpointList && !appId && !apiUrl) {
    return undefined;
  }

  return Object.freeze({
    ...(configuredEndpointList
      ? {
          endpoints: Object.freeze(
            configuredEndpointList
              .split(',')
              .map((endpoint) => endpoint.trim()),
          ),
          ...(environment.DEV && rendererOrigin
            ? {
                canonicalEndpoint:
                  developmentCanonicalNetworkOrigin(rendererOrigin),
                ...(configuredPrimaryEndpoint
                  ? { mamaBoardEndpoint: configuredPrimaryEndpoint }
                  : {}),
              }
            : {}),
        }
      : {}),
    ...(appId ? { appId } : {}),
    ...(apiUrl ? { apiUrl } : {}),
  });
}

export function resolveProductionConfiguration(
  input: MinerProductionConfigurationInput | undefined,
): Readonly<ProductionConfigurationResolution> {
  const rawEndpoints = input?.endpoints;
  const rawAppId = input?.appId;
  const apiUrl = validHttpUrl(input?.apiUrl)
    ? input.apiUrl.trim()
    : DEFAULT_BEE_API_URL;
  const maximumSessionDurationMs =
    input?.maximumSessionDurationMs ?? DEFAULT_MAXIMUM_SESSION_DURATION_MS;
  const endpointValues: readonly unknown[] = Array.isArray(rawEndpoints)
    ? rawEndpoints
    : [];
  const endpointTypesValid = endpointValues.every(
    (endpoint) => typeof endpoint === 'string',
  );
  const endpoints = endpointTypesValid
    ? (endpointValues as readonly string[]).map((endpoint) => endpoint.trim())
    : [];
  const rawCanonicalEndpoint = input?.canonicalEndpoint;
  const canonicalEndpointTypeValid =
    rawCanonicalEndpoint === undefined ||
    typeof rawCanonicalEndpoint === 'string';
  const canonicalEndpoint =
    typeof rawCanonicalEndpoint === 'string' && rawCanonicalEndpoint.trim()
      ? rawCanonicalEndpoint.trim()
      : endpoints[0] ?? '';
  const rawMamaBoardEndpoint = input?.mamaBoardEndpoint;
  const mamaBoardEndpointTypeValid =
    rawMamaBoardEndpoint === undefined ||
    typeof rawMamaBoardEndpoint === 'string';
  const mamaBoardEndpoint =
    typeof rawMamaBoardEndpoint === 'string' && rawMamaBoardEndpoint.trim()
      ? rawMamaBoardEndpoint.trim()
      : endpoints[0] ?? '';
  const appIdTypeValid = rawAppId === undefined || typeof rawAppId === 'string';
  const appId = typeof rawAppId === 'string' ? rawAppId.trim() : '';
  const missing = endpoints.length === 0 || appId.length === 0;
  const invalid =
    !endpointTypesValid ||
    !appIdTypeValid ||
    endpoints.some((endpoint) => endpoint.length === 0) ||
    !canonicalEndpointTypeValid ||
    (endpoints.length > 0 && !validHttpUrl(canonicalEndpoint)) ||
    !mamaBoardEndpointTypeValid ||
    (rawMamaBoardEndpoint !== undefined &&
      !validHttpsUrl(mamaBoardEndpoint)) ||
    new Set(endpoints).size !== endpoints.length ||
    !Number.isFinite(maximumSessionDurationMs) ||
    maximumSessionDurationMs <= 0 ||
    maximumSessionDurationMs > MAXIMUM_ALLOWED_SESSION_DURATION_MS;
  const status: ProductionConfigurationStatus = invalid
    ? 'invalid'
    : missing
      ? 'missing'
      : 'ready';
  const code =
    status === 'ready'
      ? 'production-configuration-ready'
      : status === 'missing'
        ? 'production-configuration-missing'
        : 'production-configuration-invalid';
  const snapshot = Object.freeze({
    status,
    code,
    endpointCount: endpoints.filter((endpoint) => endpoint.length > 0).length,
    appIdConfigured: appId.length > 0,
    maximumSessionDurationMs,
  });

  return Object.freeze({
    snapshot,
    value:
      status === 'ready'
        ? Object.freeze({
            endpoints: Object.freeze([...endpoints]),
            canonicalEndpoint,
            mamaBoardEndpoint,
            appId,
            maximumSessionDurationMs,
            apiUrl,
          })
        : null,
  });
}

function developmentCanonicalNetworkOrigin(rendererOrigin: string): string {
  const renderer = new URL(rendererOrigin);
  const canonical = new URL(renderer.origin);

  // Chromium limits HTTP/1.1 connections per destination host. Bee owns the
  // renderer hostname, while the canonical GraphQL clock uses the same local
  // Vite proxy through the IPv6 loopback host and therefore a separate pool.
  canonical.hostname = '[::1]';
  return canonical.origin;
}

function validHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return false;
  }

  try {
    const protocol = new URL(value.trim()).protocol;
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

function validHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return false;
  }

  try {
    return new URL(value.trim()).protocol === 'https:';
  } catch {
    return false;
  }
}
