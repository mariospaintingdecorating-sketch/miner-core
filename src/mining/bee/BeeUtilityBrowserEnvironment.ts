interface BrowserCompatibleGlobal {
  readonly fetch?: unknown;
  readonly crypto?: {
    readonly getRandomValues?: unknown;
    readonly subtle?: unknown;
  };
  window?: unknown;
  self?: unknown;
  Window?: unknown;
}

/**
 * Bee 4 uses wasm-bindgen's web_sys::window() even inside Electron's Node
 * utility process. Node already supplies fetch and Web Crypto; expose that
 * same global under the two browser aliases Bee resolves.
 */
export function installBeeUtilityBrowserEnvironment(
  target: BrowserCompatibleGlobal = globalThis as BrowserCompatibleGlobal,
): void {
  if (
    typeof target.fetch !== 'function' ||
    typeof target.crypto?.getRandomValues !== 'function' ||
    !target.crypto.subtle
  ) {
    throw new Error('Bee utility browser primitives are unavailable.');
  }
  defineGlobalAlias(target, 'window');
  defineGlobalAlias(target, 'self');
  defineWindowConstructor(target);
}

function defineWindowConstructor(target: BrowserCompatibleGlobal): void {
  if (typeof target.Window === 'function') return;
  if (target.Window !== undefined && target.Window !== null) {
    throw new Error('Bee utility global Window is already owned.');
  }
  class BeeUtilityWindow {
    static [Symbol.hasInstance](value: unknown): boolean {
      return value === target;
    }
  }
  Object.defineProperty(target, 'Window', {
    value: BeeUtilityWindow,
    configurable: true,
    enumerable: false,
    writable: false,
  });
}

function defineGlobalAlias(
  target: BrowserCompatibleGlobal,
  name: 'window' | 'self',
): void {
  if (target[name] === target) return;
  if (target[name] !== undefined && target[name] !== null) {
    throw new Error(`Bee utility global ${name} is already owned.`);
  }
  Object.defineProperty(target, name, {
    value: target,
    configurable: true,
    enumerable: false,
    writable: false,
  });
}
