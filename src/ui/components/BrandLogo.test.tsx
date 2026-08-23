import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BrandLogo } from './BrandLogo';

describe('BrandLogo', () => {
  it('renders the reduced primary sidebar logo with a vertical title', () => {
    const markup = renderToStaticMarkup(<BrandLogo />);

    expect(markup).toContain('msii-logo-ui.png');
    expect(markup).not.toContain('miner-core-msii.svg');
    expect(markup).toContain('width="216"');
    expect(markup).toContain('height="216"');
    expect(markup).toContain('brand-vertical-title');
    expect(markup).toContain('Core Miner MSII');
    expect(markup).not.toContain('Operator console');
  });

  it('keeps the compact header logo bounded', () => {
    const markup = renderToStaticMarkup(<BrandLogo compact />);

    expect(markup).toContain('brand-lockup-compact');
    expect(markup).toContain('width="37"');
    expect(markup).toContain('height="37"');
  });
});
