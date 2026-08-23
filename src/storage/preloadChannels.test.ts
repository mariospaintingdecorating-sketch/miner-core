import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { STORAGE_CHANNELS } from '../../electron/storageChannels';

describe('storage preload channels', () => {
  it('keeps the sandbox-safe preload channel list aligned with main process handlers', () => {
    const preloadSource = readFileSync(
      fileURLToPath(new URL('../../electron/preload.cts', import.meta.url)),
      'utf8',
    );
    const mainSource = readFileSync(
      fileURLToPath(new URL('../../electron/main.ts', import.meta.url)),
      'utf8',
    );
    const adapterSource = readFileSync(
      fileURLToPath(new URL('./ElectronStorageAdapter.ts', import.meta.url)),
      'utf8',
    );

    for (const [name, channel] of Object.entries(STORAGE_CHANNELS)) {
      expect(preloadSource).toContain(`'${channel}'`);
      expect(mainSource).toContain(`STORAGE_CHANNELS.${name}`);
      expect(adapterSource).toContain(`#bridge.${name}`);
    }
  });

  it('does not expose the removed settings persistence API through IPC', () => {
    const sources = [
      '../../electron/preload.cts',
      '../../electron/main.ts',
      './ElectronStorageAdapter.ts',
    ].map((path) =>
      readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8'),
    );

    expect(Object.values(STORAGE_CHANNELS)).not.toContain(
      'storage:settings:load',
    );
    expect(Object.values(STORAGE_CHANNELS)).not.toContain(
      'storage:settings:save',
    );
    for (const source of sources) {
      expect(source).not.toContain('loadSettings');
      expect(source).not.toContain('saveSettings');
    }
  });
});
