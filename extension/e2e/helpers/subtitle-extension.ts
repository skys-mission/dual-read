import { chromium, firefox, type BrowserContext, type Page } from '@playwright/test';
import { withExtension } from 'playwright-webextext';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Fresh production bundles with a test-only host grant and control relay. */
export async function launchSubtitleExtension(name: 'chromium' | 'firefox') {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-read-subtitle-e2e-'));
  const addon = path.join(temporary, 'addon');
  const profile = path.join(temporary, 'profile');
  const build = new URL(name === 'firefox' ? '../../output/firefox-mv3/' : '../../output/chrome-mv3/', import.meta.url);
  await fs.cp(build, addon, { recursive: true });
  await fs.mkdir(profile);
  const manifestPath = path.join(addon, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.host_permissions.push('https://www.youtube.com/*');
  // playwright-webextext reads the first content_scripts.matches when granting
  // test host permissions; a no-op entry avoids its empty-array bug.
  manifest.content_scripts = [{ matches: ['https://www.youtube.com/*'], js: ['test-idle.js'] }];
  manifest.optional_permissions ??= [];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await fs.writeFile(path.join(addon, 'test-idle.js'), `
window.addEventListener('message', event => {
  if(event.source!==window || event.data?.type!=='dual-read-test:command')return;
  chrome.runtime.sendMessage(event.data.message, reply => {
    window.postMessage({type:'dual-read-test:reply',id:event.data.id,reply,error:chrome.runtime.lastError?.message},location.origin);
  });
});
document.documentElement.dataset.testAddonReady='true';
`);
  // The real onboarding document opens after onInstalled saves its defaults.
  // Firefox does not expose extension documents as ordinary Playwright Pages.
  await fs.writeFile(path.join(addon, 'test-ready.js'), "chrome.runtime.sendMessage({action:'test:installed'});");
  const onboardingPath = path.join(addon, 'onboarding.html');
  await fs.writeFile(onboardingPath, (await fs.readFile(onboardingPath, 'utf8')).replace('</body>', '<script src="test-ready.js"></script></body>'));
  const background = manifest.background.service_worker ?? manifest.background.scripts[0];
  await fs.appendFile(path.join(addon, background), `
let testInstalled;
const testInstallationReady=new Promise(resolve=>{testInstalled=resolve;});
chrome.runtime.onMessage.addListener((m,s,reply) => {
  if(m.action==='test:installed'){testInstalled();return;}
  if(!s.tab?.id || s.frameId!==0)return;
  if(m.action==='test:seed') {
    (async()=>{
      await testInstallationReady;
      await Promise.all([
      chrome.storage.sync.set({schemaVersion:5,connectionMode:'proxy',apiBase:m.apiBase,model:'test-only',targetLang:'zh-CN',uiLocale:'en',mode:'bilingual',siteRules:[]}),
      chrome.storage.local.set({apiKey:'',youtubeAuto:false})
      ]);
      return {success:true};
    })().then(reply,error=>reply({success:false,error:String(error)}));return true;
  }
  if(m.action==='test:status') {
    chrome.tabs.sendMessage(s.tab.id,{action:'subtitle:status'},{frameId:0}).then(reply,()=>reply(null));return true;
  }
  if(m.action==='test:page') {
    (async()=>{
      await chrome.scripting.executeScript({target:{tabId:s.tab.id,frameIds:[0]},files:['dual-read.js']});
      await chrome.scripting.insertCSS({target:{tabId:s.tab.id,frameIds:[0]},files:['dual-read.css']});
      return chrome.tabs.sendMessage(s.tab.id,{action:'translatePage',config:m.config},{frameId:0});
    })().then(reply);return true;
  }
  if(m.action==='test:pageRestore') {
    chrome.tabs.sendMessage(s.tab.id,{action:'restoreOriginal'},{frameId:0}).then(reply);return true;
  }
  if(m.action==='test:reinject') {
    chrome.scripting.executeScript({target:{tabId:s.tab.id,frameIds:[0]},files:['youtube-subtitles.js']}).then(()=>reply({success:true}));return true;
  }
  if(m.action==='test:preferences') {
    chrome.storage.sync.get(['targetLang','subtitles']).then(reply);return true;
  }
  if(m.action==='test:autoPolicy') {
    chrome.storage.local.set({youtubeAuto:m.enabled===true}).then(()=>reply({success:true}));return true;
  }
  if(m.action==='test:siteDisabled') {
    chrome.storage.sync.set({siteRules:m.disabled?[{host:'www.youtube.com',disabled:true}]:[]}).then(()=>reply({success:true}));return true;
  }
});
`);
  let context: BrowserContext | undefined;
  try {
    context = name === 'firefox'
      ? await withExtension(firefox, addon).launchPersistentContext(profile, { headless: true })
      : await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
        args: [`--disable-extensions-except=${addon}`, `--load-extension=${addon}`] });
    return { context,
      async message(page: Page, message: Record<string, unknown>): Promise<any> {
        await page.waitForFunction(() => document.documentElement.dataset.testAddonReady === 'true');
        return page.evaluate(message => new Promise((resolve, reject) => {
          const id = crypto.randomUUID();
          const timer = setTimeout(() => { window.removeEventListener('message', listener); reject(new Error('Test relay timeout')); }, 15_000);
          const listener = (event: MessageEvent) => {
            if (event.source !== window || event.data?.type !== 'dual-read-test:reply' || event.data.id !== id) return;
            clearTimeout(timer); window.removeEventListener('message', listener);
            if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.reply);
          };
          window.addEventListener('message', listener);
          window.postMessage({type:'dual-read-test:command',id,message},location.origin);
        }), message);
      },
      async close() { await context!.close(); await fs.rm(temporary, { recursive: true, force: true }); } };
  } catch (error) {
    await context?.close(); await fs.rm(temporary, { recursive: true, force: true }); throw error;
  }
}
