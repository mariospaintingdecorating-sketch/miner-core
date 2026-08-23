import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Windows installer profile handling', () => {
  const packageConfiguration = JSON.parse(
    readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
  ) as {
    build: {
      nsis: {
        include?: string;
        deleteAppDataOnUninstall?: boolean;
      };
    };
  };
  const installerInclude = readFileSync(
    join(process.cwd(), 'build', 'installer.nsh'),
    'utf8',
  );

  it('preserves installed application data by default', () => {
    expect(packageConfiguration.build.nsis.deleteAppDataOnUninstall).toBe(false);
    expect(packageConfiguration.build.nsis.include).toBe('build/installer.nsh');
    expect(installerInclude).toContain('StrCpy $CoreMinerProfileChoice "keep"');
    expect(installerInclude).toContain('${NSD_Check} $CoreMinerKeepProfileRadio');
  });

  it('limits the explicit clean-install choice to the installed profile', () => {
    expect(installerInclude).toContain(
      'IfFileExists "$APPDATA\\Miner Core\\miner-core.sqlite"',
    );
    expect(installerInclude).toContain('RMDir /r "$APPDATA\\Miner Core"');
    expect(installerInclude).not.toContain('$APPDATA\\miner-core');
    expect(installerInclude).toContain('MB_YESNO|MB_DEFBUTTON2');
  });
});
