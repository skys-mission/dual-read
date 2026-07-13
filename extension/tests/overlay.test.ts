// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hideOverlay, showLoading, showResult } from '../lib/overlay';

const labels = { title: 'Dual Read', copy: 'Copy', close: 'Close' };

afterEach(() => {
  hideOverlay();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('selection overlay', () => {
  it('ignores outside mousedown during the context-menu grace period', () => {
    vi.useFakeTimers();
    showLoading('hello world', labels);
    const host = document.getElementById('dual-read-overlay-host');
    expect(host).toBeTruthy();

    // Same gesture that dismissed the context menu.
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(document.getElementById('dual-read-overlay-host')).toBeTruthy();

    vi.advanceTimersByTime(450);
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(document.getElementById('dual-read-overlay-host')).toBeNull();
  });

  it('keeps the panel after a result update within the grace window', () => {
    vi.useFakeTimers();
    showLoading('hello', labels);
    showResult('hello', '你好', labels);
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(document.getElementById('dual-read-overlay-host')).toBeTruthy();
    const body = document
      .getElementById('dual-read-overlay-host')!
      .shadowRoot!
      .querySelector('.dr-body');
    expect(body?.textContent).toBe('你好');
  });

  it('reuses one host across repeated selection translations', () => {
    vi.useFakeTimers();
    showLoading('first selection', labels);
    showResult('first selection', '第一段', labels);
    showLoading('second selection', labels);
    showResult('second selection', '第二段', labels);

    const hosts = document.querySelectorAll('#dual-read-overlay-host');
    expect(hosts).toHaveLength(1);
    expect(hosts[0].shadowRoot?.querySelector('.dr-original')?.textContent)
      .toBe('second selection');
    expect(hosts[0].shadowRoot?.querySelector('.dr-body')?.textContent)
      .toBe('第二段');
  });

  it('refreshes visible and accessible labels when reusing the overlay', () => {
    vi.useFakeTimers();
    showLoading('hello', labels);
    const host = document.getElementById('dual-read-overlay-host')!;
    const localized = { title: '翻译', copy: '复制', close: '关闭' };

    showLoading('hello', localized);

    expect(document.querySelectorAll('#dual-read-overlay-host')).toHaveLength(1);
    expect(host.shadowRoot?.querySelector('.dr-title')?.textContent).toBe('翻译');
    const buttons = host.shadowRoot?.querySelectorAll<HTMLButtonElement>('.dr-btn');
    expect(buttons?.[0].textContent).toBe('复制');
    expect(buttons?.[0].getAttribute('aria-label')).toBe('复制');
    expect(buttons?.[1].textContent).toBe('关闭');
    expect(buttons?.[1].getAttribute('aria-label')).toBe('关闭');
  });

  it('cancels deferred document listeners when hidden immediately', () => {
    vi.useFakeTimers();
    const addListener = vi.spyOn(document, 'addEventListener');
    try {
      showLoading('short-lived selection', labels);
      hideOverlay();
      vi.runAllTimers();

      const eventTypes = addListener.mock.calls.map(([type]) => type);
      expect(eventTypes).not.toContain('mousedown');
      expect(eventTypes).not.toContain('keydown');
      expect(document.getElementById('dual-read-overlay-host')).toBeNull();
    } finally {
      addListener.mockRestore();
    }
  });
});
