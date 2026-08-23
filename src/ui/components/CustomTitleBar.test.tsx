import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CustomTitleBar } from './CustomTitleBar';

describe('CustomTitleBar', () => {
  it('renders approved branding and exactly three window controls', () => {
    const html = renderToStaticMarkup(<CustomTitleBar controls={windowControls()} />);

    expect(html).toContain('data-testid="custom-title-bar"');
    expect(html).toContain('msii-logo-ui.png');
    expect(html).toContain('Core Miner');
    expect(html.match(/<button/g)).toHaveLength(3);
    expect(html).toContain('Minimize window');
    expect(html).toContain('Maximize window');
    expect(html).toContain('Close window');
    expect(html).not.toContain('File');
    expect(html).not.toContain('Edit');
    expect(html).not.toContain('View');
    expect(html).not.toContain('Window</');
  });

  it('does not render competing custom chrome when preload is stale', () => {
    expect(renderToStaticMarkup(<CustomTitleBar controls={null} />)).toBe('');
  });
});

function windowControls() {
  return {
    minimize: vi.fn(async () => undefined),
    toggleMaximize: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    isMaximized: vi.fn(async () => false),
    onMaximizedChanged: vi.fn(() => () => undefined),
  };
}
