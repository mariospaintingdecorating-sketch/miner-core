import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TokenIcon, TokenIdentity } from './TokenIdentity';

describe('TokenIdentity', () => {
  it('uses consistent local SVG identities and supported badges', () => {
    const html = renderToStaticMarkup(
      <>
        <TokenIdentity badge="LOCKED" token="nackl" />
        <TokenIdentity badge="AVAILABLE" token="nackl" />
        <TokenIdentity token="shell" />
        <TokenIdentity badge="ECC" token="usdc" />
        <TokenIcon size="small" token="nackl" />
      </>,
    );

    expect(html.match(/<svg/g)).toHaveLength(5);
    expect(html).toContain('data-token="nackl"');
    expect(html).toContain('data-token="shell"');
    expect(html).toContain('data-token="usdc"');
    expect(html).toContain('>LOCKED<');
    expect(html).toContain('>AVAILABLE<');
    expect(html).toContain('>ECC<');
    expect(html).not.toContain('🪙');
  });
});
