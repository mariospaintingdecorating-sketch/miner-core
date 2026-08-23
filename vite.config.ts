import {
  defineConfig,
  loadEnv,
  type Plugin,
  type ProxyOptions,
  type UserConfig,
} from 'vite';
import react from '@vitejs/plugin-react';
import { appendFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

type ViteEnvironment = Readonly<Record<string, string | undefined>>;
export const MINER_CORE_DEV_GRAPHQL_PROXY_PATH = '/graphql';
export const MINER_CORE_DEV_V2_PROXY_PATH = '/v2';
export const MINER_CORE_DEV_PORT = 5173;

export type DevProxyRequestResult =
  | 'success'
  | 'non_2xx'
  | 'timeout'
  | 'aborted'
  | 'proxy_error';

export interface DevProxyRequestDiagnostic {
  readonly requestId: string;
  readonly timestampStart: string;
  readonly timestampEnd: string;
  readonly method: string;
  readonly pathname: string;
  readonly httpStatus: number | null;
  readonly durationMs: number;
  readonly result: DevProxyRequestResult;
  readonly contentType: string | null;
  readonly contentLength: number | null;
  readonly activeGraphqlAtStart: number;
  readonly activeGraphqlAtEnd: number;
  readonly peakActiveGraphql: number;
  readonly completedGraphqlCount: number;
  readonly failedGraphqlCount: number;
  readonly upstreamSocketReused: boolean | null;
  readonly upstreamLocalPort: number | null;
  readonly upstreamRemoteHost: string;
  readonly upstreamHttpVersion: string | null;
}

export type DevProxyDiagnosticSink = (
  diagnostic: Readonly<DevProxyRequestDiagnostic>,
) => void;

export function createMinerViteConfig(
  environment: ViteEnvironment,
  diagnosticSink?: DevProxyDiagnosticSink,
): UserConfig {
  const target = configuredMainnetTarget(environment);
  const diagnosticLogPath = configuredDiagnosticLogPath(environment);
  const resolvedDiagnosticSink =
    diagnosticSink ?? persistentDevProxyDiagnosticSink(diagnosticLogPath);
  const graphqlDiagnostics = createGraphqlDiagnosticsState();

  return {
    base: './',
    plugins: [
      react(),
      ...(target ? [devProxyOwnerPlugin(diagnosticLogPath)] : []),
    ],
    server: {
      host: '::1',
      port: MINER_CORE_DEV_PORT,
      strictPort: true,
      ...(target
        ? {
            proxy: {
              [MINER_CORE_DEV_GRAPHQL_PROXY_PATH]: devMainnetProxy(
                target,
                resolvedDiagnosticSink,
                graphqlDiagnostics,
              ),
              [MINER_CORE_DEV_V2_PROXY_PATH]: devMainnetProxy(
                target,
                resolvedDiagnosticSink,
                graphqlDiagnostics,
              ),
            },
          }
        : {}),
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
  };
}

function devMainnetProxy(
  target: string,
  diagnosticSink: DevProxyDiagnosticSink,
  graphqlDiagnostics: GraphqlDiagnosticsState,
): ProxyOptions {
  const upstreamRemoteHost = new URL(target).hostname;

  return {
    target,
    changeOrigin: true,
    rewrite: (path: string) => path,
    configure: (proxy) => {
      const requests = new WeakMap<object, ProxyRequestState>();

      const requestState = (incomingRequest: object & {
        readonly method?: string;
        readonly url?: string;
        once?: (event: string, listener: () => void) => unknown;
      }): ProxyRequestState | null => {
        const existing = requests.get(incomingRequest);
        if (existing) return existing;

        const pathname = proxyPathname(incomingRequest.url);
        const isGraphql = pathname === MINER_CORE_DEV_GRAPHQL_PROXY_PATH;
        if (!isGraphql && pathname !== '/v2/messages') return null;

        graphqlDiagnostics.requestSequence += 1;
        if (isGraphql) {
          graphqlDiagnostics.active += 1;
          graphqlDiagnostics.peak = Math.max(
            graphqlDiagnostics.peak,
            graphqlDiagnostics.active,
          );
        }

        const state: ProxyRequestState = {
          requestId: `${isGraphql ? 'graphql' : 'v2-messages'}:${graphqlDiagnostics.requestSequence}`,
          startedAtMs: Date.now(),
          method: incomingRequest.method?.toUpperCase() || 'UNKNOWN',
          pathname,
          isGraphql,
          activeGraphqlAtStart: graphqlDiagnostics.active,
          completed: false,
          upstreamStatus: null,
          responseContentType: null,
          responseByteCount: null,
          upstreamSocketReused: null,
          upstreamLocalPort: null,
          upstreamRemoteHost,
          upstreamHttpVersion: null,
        };
        requests.set(incomingRequest, state);
        incomingRequest.once?.('aborted', () => {
          finishDevProxyRequest(
            requests,
            incomingRequest,
            state,
            'aborted',
            diagnosticSink,
            graphqlDiagnostics,
          );
        });
        return state;
      };

      proxy.on('start', (incomingRequest) => {
        requestState(incomingRequest);
      });

      proxy.on('proxyReq', (request, incomingRequest, _response, _options, socket) => {
        request.removeHeader('origin');
        request.removeHeader('referer');

        const state = requestState(incomingRequest);
        if (!state) return;
        state.upstreamSocketReused =
          typeof request.reusedSocket === 'boolean' ? request.reusedSocket : null;
        state.upstreamLocalPort = safePort(socket?.localPort);
      });

      proxy.on('proxyRes', (response, incomingRequest) => {
        const state = requests.get(incomingRequest);
        if (!state) return;

        state.upstreamStatus = response.statusCode ?? null;
        state.responseContentType = firstHeaderValue(
          response.headers['content-type'],
        );
        state.responseByteCount = numericHeaderValue(
          response.headers['content-length'],
        );
        state.upstreamHttpVersion = response.httpVersion || null;
        response.once('end', () => {
          finishDevProxyRequest(
            requests,
            incomingRequest,
            state,
            responseResult(state.upstreamStatus),
            diagnosticSink,
            graphqlDiagnostics,
          );
        });
        response.once('aborted', () => {
          finishDevProxyRequest(
            requests,
            incomingRequest,
            state,
            'aborted',
            diagnosticSink,
            graphqlDiagnostics,
          );
        });
        response.once('error', () => {
          finishDevProxyRequest(
            requests,
            incomingRequest,
            state,
            'proxy_error',
            diagnosticSink,
            graphqlDiagnostics,
          );
        });
        response.once('close', () => {
          if (!response.complete) {
            finishDevProxyRequest(
              requests,
              incomingRequest,
              state,
              'aborted',
              diagnosticSink,
              graphqlDiagnostics,
            );
          }
        });
      });

      proxy.on('error', (error, incomingRequest) => {
        const state = requests.get(incomingRequest);
        if (!state) return;
        finishDevProxyRequest(
          requests,
          incomingRequest,
          state,
          proxyErrorResult(error),
          diagnosticSink,
          graphqlDiagnostics,
        );
      });
    },
  };
}

interface ProxyRequestState {
  readonly requestId: string;
  readonly startedAtMs: number;
  readonly method: string;
  readonly pathname: string;
  readonly isGraphql: boolean;
  readonly activeGraphqlAtStart: number;
  completed: boolean;
  upstreamStatus: number | null;
  responseContentType: string | null;
  responseByteCount: number | null;
  upstreamSocketReused: boolean | null;
  upstreamLocalPort: number | null;
  readonly upstreamRemoteHost: string;
  upstreamHttpVersion: string | null;
}

interface GraphqlDiagnosticsState {
  active: number;
  peak: number;
  completed: number;
  failed: number;
  requestSequence: number;
}

function createGraphqlDiagnosticsState(): GraphqlDiagnosticsState {
  return {
    active: 0,
    peak: 0,
    completed: 0,
    failed: 0,
    requestSequence: 0,
  };
}

function finishDevProxyRequest(
  requests: WeakMap<object, ProxyRequestState>,
  request: object,
  state: ProxyRequestState,
  result: DevProxyRequestResult,
  sink: DevProxyDiagnosticSink,
  graphqlDiagnostics: GraphqlDiagnosticsState,
): void {
  if (state.completed) return;
  state.completed = true;
  requests.delete(request);
  if (state.isGraphql) {
    graphqlDiagnostics.active = Math.max(0, graphqlDiagnostics.active - 1);
    graphqlDiagnostics.completed += 1;
    if (result !== 'success') {
      graphqlDiagnostics.failed += 1;
    }
  }
  const endedAtMs = Date.now();
  const diagnostic = Object.freeze({
    requestId: state.requestId,
    timestampStart: new Date(state.startedAtMs).toISOString(),
    timestampEnd: new Date(endedAtMs).toISOString(),
    method: state.method,
    pathname: state.pathname,
    httpStatus: state.upstreamStatus,
    durationMs: Math.max(0, Math.round(endedAtMs - state.startedAtMs)),
    result,
    contentType: state.responseContentType,
    contentLength: state.responseByteCount,
    activeGraphqlAtStart: state.activeGraphqlAtStart,
    activeGraphqlAtEnd: graphqlDiagnostics.active,
    peakActiveGraphql: graphqlDiagnostics.peak,
    completedGraphqlCount: graphqlDiagnostics.completed,
    failedGraphqlCount: graphqlDiagnostics.failed,
    upstreamSocketReused: state.upstreamSocketReused,
    upstreamLocalPort: state.upstreamLocalPort,
    upstreamRemoteHost: state.upstreamRemoteHost,
    upstreamHttpVersion: state.upstreamHttpVersion,
  });

  try {
    sink(diagnostic);
  } catch {
    // Development transport diagnostics cannot affect proxy responses.
  }
}

function proxyPathname(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value, 'http://localhost').pathname;
  } catch {
    return null;
  }
}

function firstHeaderValue(value: string | readonly string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && first.trim() ? first.trim() : null;
}

function numericHeaderValue(value: string | readonly string[] | undefined): number | null {
  const first = firstHeaderValue(value);
  if (!first) return null;
  const parsed = Number(first);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function safePort(value: number | undefined): number | null {
  return Number.isSafeInteger(value) && value! >= 1 && value! <= 65_535
    ? value!
    : null;
}

function proxyErrorResult(error: Error): DevProxyRequestResult {
  const code = 'code' in error ? String(error.code) : '';
  return /TIMEOUT|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(`${code} ${error.name}`)
    ? 'timeout'
    : 'proxy_error';
}

function responseResult(status: number | null): DevProxyRequestResult {
  if (status === null) return 'proxy_error';
  return status >= 200 && status < 300 ? 'success' : 'non_2xx';
}

function logDevProxyDiagnostic(
  diagnostic: Readonly<DevProxyRequestDiagnostic>,
): void {
  console.info(`[miner-core-dev-proxy] ${JSON.stringify(diagnostic)}`);
}

function persistentDevProxyDiagnosticSink(
  logPath: string,
): DevProxyDiagnosticSink {
  return (diagnostic) => {
    logDevProxyDiagnostic(diagnostic);
    void appendDiagnosticLine(logPath, JSON.stringify(diagnostic));
  };
}

function devProxyOwnerPlugin(logPath: string): Plugin {
  return {
    name: 'miner-core-dev-proxy-owner',
    apply: 'serve',
    configureServer(server) {
      const announceOwner = () => {
        const line =
          `[minercore-dev-proxy-owner] pid=${process.pid} ` +
          `port=${MINER_CORE_DEV_PORT} log=${logPath}`;
        console.info(line);
        void appendDiagnosticLine(logPath, line);
      };

      if (server.httpServer?.listening) {
        announceOwner();
      } else {
        server.httpServer?.once('listening', announceOwner);
      }
    },
  };
}

async function appendDiagnosticLine(
  logPath: string,
  line: string,
): Promise<void> {
  try {
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, `${line}\n`, 'utf8');
  } catch {
    // Development diagnostics must never affect proxy traffic or mining.
  }
}

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), [
    'VITE_MINER_CORE_BEE_ENDPOINTS',
    'VITE_ACKI_ENDPOINT',
  ]);
  return createMinerViteConfig({
    ...environment,
    MINER_CORE_DEV_PROXY_LOG: process.env.MINER_CORE_DEV_PROXY_LOG,
  });
});

function configuredDiagnosticLogPath(environment: ViteEnvironment): string {
  const configured = environment.MINER_CORE_DEV_PROXY_LOG?.trim();
  return resolve(configured || tmpdir(), configured ? '' : 'miner-core-dev-proxy.jsonl');
}

function configuredMainnetTarget(
  environment: ViteEnvironment,
): string | null {
  const configured =
    environment.VITE_MINER_CORE_BEE_ENDPOINTS?.trim() ||
    environment.VITE_ACKI_ENDPOINT?.trim();
  const firstEndpoint = configured?.split(',')[0]?.trim();

  if (!firstEndpoint) return null;

  try {
    const target = new URL(firstEndpoint);
    return target.protocol === 'https:' || target.protocol === 'http:'
      ? target.toString().replace(/\/$/, '')
      : null;
  } catch {
    return null;
  }
}
