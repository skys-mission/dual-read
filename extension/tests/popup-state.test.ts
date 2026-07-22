import { describe, expect, it } from 'vitest';
import { derivePopupView, type PopupSnapshot } from '../lib/popup/state';

function base(partial: Partial<PopupSnapshot> = {}): PopupSnapshot {
  return {
    configured: true,
    hasTab: true,
    restricted: false,
    siteDisabled: false,
    translating: false,
    watching: false,
    count: 0,
    total: 0,
    failed: 0,
    ...partial,
  };
}

describe('derivePopupView', () => {
  it('requires setup when not configured', () => {
    const v = derivePopupView(base({ configured: false }));
    expect(v.phase).toBe('config-required');
    expect(v.primary).toBe('setup');
    expect(v.controlsEnabled).toBe(false);
  });

  it('marks restricted pages as unsupported with no primary action', () => {
    const v = derivePopupView(base({ restricted: true }));
    expect(v.phase).toBe('unsupported');
    expect(v.primary).toBe('none');
    expect(v.primaryDisabled).toBe(true);
    expect(v.statusKey).toBe('statusRestricted');
  });

  it('marks disabled sites as unsupported', () => {
    const v = derivePopupView(base({ siteDisabled: true }));
    expect(v.phase).toBe('unsupported');
    expect(v.statusKey).toBe('statusSiteDisabled');
  });

  it('uses stop as the only primary CTA while translating', () => {
    const v = derivePopupView(base({ translating: true, count: 2, total: 10 }));
    expect(v.phase).toBe('translating');
    expect(v.primary).toBe('stop');
    expect(v.statusKey).toBe('statusProgress');
    expect(v.statusSubs).toEqual([2, 10]);
    expect(v.showSecondaryRestore).toBe(false);
    expect(v.progress).toEqual({ count: 2, total: 10 });
  });

  it('uses busy flag as translating', () => {
    const v = derivePopupView(base({ busy: true }));
    expect(v.phase).toBe('translating');
    expect(v.primary).toBe('stop');
    expect(v.statusKey).toBe('statusTranslating');
  });

  it('watching without failures → restore primary', () => {
    const v = derivePopupView(base({ watching: true, count: 5, total: 5 }));
    expect(v.phase).toBe('watching');
    expect(v.primary).toBe('restore');
  });

  it('partial failures → retryFailed primary + secondary restore', () => {
    const v = derivePopupView(base({ watching: true, count: 4, total: 6, failed: 2 }));
    expect(v.phase).toBe('partial');
    expect(v.primary).toBe('retryFailed');
    expect(v.showSecondaryRestore).toBe(true);
    expect(v.statusSubs).toEqual([4, 2]);
  });

  it('hard error → translate again', () => {
    const v = derivePopupView(base({ lastError: 'boom' }));
    expect(v.phase).toBe('error');
    expect(v.primary).toBe('translate');
    expect(v.detailText).toBe('boom');
  });

  it('maps stable error codes to humanized i18n keys', () => {
    const v = derivePopupView(base({ lastErrorCode: 'AUTH_INVALID', lastError: 'HTTP 401' }));
    expect(v.phase).toBe('error');
    expect(v.detailKey).toBe('errAuthInvalid');
    expect(v.actionKey).toBe('errActionCheckKey');
    expect(v.detailText).toBeUndefined();
  });

  it('empty page → empty phase', () => {
    const v = derivePopupView(base({ lastEmpty: true }));
    expect(v.phase).toBe('empty');
    expect(v.primary).toBe('translate');
    expect(v.statusKey).toBe('statusNoContent');
  });

  it('idle ready → translate primary', () => {
    const v = derivePopupView(base());
    expect(v.phase).toBe('idle');
    expect(v.primary).toBe('translate');
    expect(v.statusKey).toBe('statusReady');
  });

  it('idle with prior translations surfaces count on the status line', () => {
    const v = derivePopupView(base({ count: 7, total: 12 }));
    expect(v.phase).toBe('idle');
    expect(v.statusKey).toBe('statusProgress');
    expect(v.statusSubs).toEqual([7, 12]);
    expect(v.showSecondaryRestore).toBe(true);
    expect(v.progress).toEqual({ count: 7, total: 12 });
  });
});
