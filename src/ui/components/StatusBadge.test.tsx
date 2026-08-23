import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StatusBadge, statusTone } from './StatusBadge';

describe('StatusBadge', () => {
  it('maps operational states to restrained semantic tones', () => {
    expect(statusTone('running')).toBe('success');
    expect(statusTone('warning')).toBe('warning');
    expect(statusTone('error')).toBe('error');
    expect(statusTone('info')).toBe('info');
    expect(statusTone('recovery')).toBe('info');
    expect(statusTone('idle')).toBe('neutral');
  });

  it('renders the supplied state without changing it', () => {
    const html = renderToStaticMarkup(<StatusBadge label="transitioning" />);

    expect(html).toContain('transitioning');
    expect(html).toContain('status-badge-info');
  });

  it('renders operational indicators as static semantic tones', () => {
    const running = renderToStaticMarkup(<StatusBadge label="running" />);
    const active = renderToStaticMarkup(<StatusBadge label="Active" />);
    const completed = renderToStaticMarkup(<StatusBadge label="completed" />);

    expect(running).toContain('status-badge-success');
    expect(active).toContain('status-badge-neutral');
    expect(completed).toContain('status-badge-success');
  });
});
