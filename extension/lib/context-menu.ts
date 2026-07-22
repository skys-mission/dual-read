export interface ContextMenuManager {
  recreate(uiLocale: string): Promise<void>;
  updateOrRecreate(uiLocale: string): Promise<void>;
}

type TitleResolver = (uiLocale: string) => Promise<string>;

/**
 * Owns all writes for one fixed context-menu id.
 *
 * Chrome may deliver onInstalled and storage.onChanged close together. A
 * shared queue prevents remove/create and update/create from racing into a
 * duplicate id. updateOrRecreate also repairs a missing item.
 */
export function createContextMenuManager(
  id: string,
  resolveTitle: TitleResolver,
): ContextMenuManager {
  let chain: Promise<void> = Promise.resolve();

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const run = chain.catch(() => undefined).then(task);
    chain = run.catch(() => undefined);
    return run;
  };

  const remove = (): Promise<void> =>
    new Promise((resolve) => {
      chrome.contextMenus.remove(id, () => {
        // Missing is expected during first install/recovery.
        void chrome.runtime.lastError;
        resolve();
      });
    });

  const create = (title: string): Promise<void> =>
    new Promise((resolve) => {
      chrome.contextMenus.create(
        { id, title, contexts: ['selection'] },
        () => {
          const error = chrome.runtime.lastError?.message;
          if (error) console.warn('[Dual Read] context menu create failed:', error);
          resolve();
        },
      );
    });

  const update = (title: string): Promise<boolean> =>
    new Promise((resolve) => {
      chrome.contextMenus.update(id, { title }, () => {
        const failed = Boolean(chrome.runtime.lastError);
        resolve(!failed);
      });
    });

  return {
    recreate(uiLocale: string): Promise<void> {
      return enqueue(async () => {
        const title = await resolveTitle(uiLocale);
        await remove();
        await create(title);
      });
    },

    updateOrRecreate(uiLocale: string): Promise<void> {
      return enqueue(async () => {
        const title = await resolveTitle(uiLocale);
        if (await update(title)) return;
        await remove();
        await create(title);
      });
    },
  };
}
