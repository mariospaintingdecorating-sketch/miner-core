import type {
  BeeSdkFailure,
  BeeSdkGatewayContract,
  BeeSdkGatewayStatus,
  BeeSdkOwnedResource,
  BeeSdkReadiness,
  BeeSdkResourceOwner,
  BeeSdkRuntimeAdapter,
} from './contracts';
import type { CoreEvent, EventPublisher } from '../../shared/events';
import { CoreEventEmitter } from '../../shared/events';

const INITIALIZATION_FAILURE_CODE = 'bee-sdk-initialization-failed';
const DISPOSAL_FAILURE_CODE = 'bee-sdk-disposal-failed';

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === 'string' ? error : 'Bee SDK operation failed.';
}

export class BeeSdkGateway
  implements BeeSdkGatewayContract, BeeSdkResourceOwner
{
  #status: BeeSdkGatewayStatus = 'idle';
  #version: string | null = null;
  #failure: Readonly<BeeSdkFailure> | null = null;
  #initialization: Promise<void> | null = null;
  #disposal: Promise<void> | null = null;
  #disposeRequested = false;
  #eventSequence = 0;
  readonly #resources = new Set<BeeSdkOwnedResource>();

  constructor(
    private readonly runtimeAdapter: BeeSdkRuntimeAdapter,
    private readonly eventPublisher: EventPublisher = new CoreEventEmitter(),
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  initialize(): Promise<void> {
    if (this.#disposeRequested) {
      return Promise.reject(new Error('Bee SDK gateway is disposed.'));
    }

    if (this.#initialization) {
      return this.#initialization;
    }

    this.#status = 'initializing';
    this.#initialization = this.#initialize();
    return this.#initialization;
  }

  readiness(): Readonly<BeeSdkReadiness> {
    return Object.freeze({
      status: this.#status,
      version: this.#version,
      failure: this.#failure,
    });
  }

  ownResource<TResource extends BeeSdkOwnedResource>(
    resource: TResource,
  ): TResource {
    if (this.#status !== 'ready' || this.#disposeRequested) {
      if (this.#disposeRequested) {
        try {
          resource.free();
        } catch (error) {
          // Keep failed late resources owned so the failure is observable and a
          // later explicit release can retry without losing the reference.
          this.#resources.add(resource);
          this.#recordDisposalFailure(error);
          throw new AggregateError(
            [error],
            'Bee SDK resource cleanup failed after disposal started.',
          );
        }

        throw new Error(
          'Bee SDK resource was released because the gateway is disposing.',
        );
      }

      throw new Error('Bee SDK resources require a ready gateway.');
    }

    this.#resources.add(resource);
    return resource;
  }

  releaseResource(resource: BeeSdkOwnedResource): void {
    if (!this.#resources.has(resource)) {
      return;
    }

    try {
      resource.free();
      this.#resources.delete(resource);
    } catch (error) {
      this.#recordDisposalFailure(error);
      throw error;
    }
  }

  dispose(): Promise<void> {
    if (this.#disposal) {
      return this.#disposal;
    }

    this.#disposeRequested = true;
    this.#status = 'disposing';
    this.#disposal = this.#dispose();
    return this.#disposal;
  }

  async #initialize(): Promise<void> {
    try {
      await this.runtimeAdapter.initialize();
      this.#version = this.runtimeAdapter.version();

      if (!this.#disposeRequested) {
        this.#status = 'ready';
      }

      this.#publishSdkEvent('bee-sdk-ready', null);
    } catch (error) {
      this.#failure = this.#failureSnapshot(
        INITIALIZATION_FAILURE_CODE,
        error,
      );

      if (!this.#disposeRequested) {
        this.#status = 'failed';
      }

      this.#publishSdkEvent('bee-sdk-failed', this.#failure);

      throw error;
    }
  }

  async #dispose(): Promise<void> {
    if (this.#initialization) {
      try {
        await this.#initialization;
      } catch {
        // Initialization failures are already exposed through readiness().
      }
    }

    const failures: unknown[] = [];

    for (const resource of [...this.#resources].reverse()) {
      try {
        this.releaseResource(resource);
      } catch (error) {
        failures.push(error);
      }
    }

    try {
      await this.runtimeAdapter.dispose();
    } catch (error) {
      failures.push(error);
      this.#recordDisposalFailure(error);
    }

    this.#status = 'disposed';

    if (failures.length > 0) {
      throw new AggregateError(failures, 'Bee SDK disposal failed.');
    }
  }

  #recordDisposalFailure(error: unknown): void {
    this.#failure = this.#failureSnapshot(DISPOSAL_FAILURE_CODE, error);
    this.#publishSdkEvent('bee-sdk-failed', this.#failure);
  }

  #failureSnapshot(code: string, error: unknown): Readonly<BeeSdkFailure> {
    return Object.freeze({ code, message: errorMessage(error) });
  }

  #publishSdkEvent(
    type: 'bee-sdk-ready' | 'bee-sdk-failed',
    failure: Readonly<BeeSdkFailure> | null,
  ): void {
    this.#eventSequence += 1;
    const event: CoreEvent<typeof type> = {
      id: `${type}:${this.#eventSequence}`,
      occurredAt: this.now(),
      type,
      payload: {
        version: this.#version,
        code: failure?.code ?? null,
        message: failure
          ? `Bee SDK operation failed (${failure.code}).`
          : null,
      },
    };

    try {
      this.eventPublisher.publish(event);
    } catch {
      // Operational diagnostics cannot control SDK readiness.
    }
  }
}
