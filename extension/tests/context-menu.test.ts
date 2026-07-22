import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createContextMenuManager } from '../lib/context-menu';

const remove = vi.fn();
const create = vi.fn();
const update = vi.fn();

vi.stubGlobal('chrome', {
  runtime: {
    lastError: undefined as chrome.runtime.LastError | undefined,
  },
  contextMenus: { remove, create, update },
});

describe('context menu manager', () => {
  beforeEach(() => {
    remove.mockReset();
    create.mockReset();
    update.mockReset();
    chrome.runtime.lastError = undefined;

    remove.mockImplementation((_id, cb: () => void) => cb());
    create.mockImplementation((_props, cb: () => void) => cb());
    update.mockImplementation((_id, _props, cb: () => void) => cb());
  });

  it('updates an existing item without recreating it', async () => {
    const manager = createContextMenuManager('selection', async () => '翻译选中文本');

    await manager.updateOrRecreate('zh-CN');

    expect(update).toHaveBeenCalledWith(
      'selection',
      { title: '翻译选中文本' },
      expect.any(Function),
    );
    expect(remove).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('recreates the item when update reports it missing', async () => {
    update.mockImplementationOnce((_id, _props, cb: () => void) => {
      chrome.runtime.lastError = { message: 'Cannot find menu item' };
      cb();
      chrome.runtime.lastError = undefined;
    });
    const manager = createContextMenuManager('selection', async () => 'Translate selection');

    await manager.updateOrRecreate('en');

    expect(remove).toHaveBeenCalledWith('selection', expect.any(Function));
    expect(create).toHaveBeenCalledWith(
      { id: 'selection', title: 'Translate selection', contexts: ['selection'] },
      expect.any(Function),
    );
  });

  it('serializes recreate and locale-update writes', async () => {
    const calls: string[] = [];
    remove.mockImplementation((_id, cb: () => void) => {
      calls.push('remove');
      cb();
    });
    create.mockImplementation((_props, cb: () => void) => {
      calls.push('create');
      cb();
    });
    update.mockImplementation((_id, _props, cb: () => void) => {
      calls.push('update');
      cb();
    });

    let releaseEnglish!: (title: string) => void;
    const resolveTitle = vi.fn((locale: string) => {
      if (locale === 'en') {
        return new Promise<string>((resolve) => {
          releaseEnglish = resolve;
        });
      }
      return Promise.resolve('翻译选中文本');
    });
    const manager = createContextMenuManager('selection', resolveTitle);

    const install = manager.recreate('en');
    const localeChange = manager.updateOrRecreate('zh-CN');
    await Promise.resolve();
    await Promise.resolve();
    expect(resolveTitle).toHaveBeenCalledTimes(1);

    releaseEnglish('Translate selection');
    await Promise.all([install, localeChange]);

    expect(resolveTitle.mock.calls.map(([locale]) => locale)).toEqual(['en', 'zh-CN']);
    expect(calls).toEqual(['remove', 'create', 'update']);
  });
});
