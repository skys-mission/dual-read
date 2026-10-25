// Interactive, opt-in live validation. No fixture routes or browser API shims.
// Run from extension/: node tools/youtube-live-validation/run.mjs
// Enter one JSON command per line: status, source, start, stop, metrics, shot, exit.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { firefox } from '@playwright/test';
import { withExtension } from 'playwright-webextext';
import { installControlledSource, runControlledValidation } from './controlled-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const controlled = process.argv.includes('--controlled-source');
const settings = JSON.parse(await fs.readFile(path.join(root, 'dev-settings.json'), 'utf8'));
const api = new URL(settings.apiBase);
if (api.protocol !== 'https:' || api.username || api.password || api.search) throw new Error('Expected configured HTTPS API origin');
if (!settings.apiKey || !settings.model) throw new Error('Real service is not configured');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-read-youtube-live-'));
const addon = path.join(temporary, 'addon');
const profile = path.join(temporary, 'profile');
await fs.cp(path.join(root, 'output/firefox-mv3'), addon, { recursive: true });
await fs.mkdir(profile);
const configToken = randomUUID();
let configRead = false;
const server = http.createServer((req, res) => {
  if (req.url !== `/${configToken}` || configRead) { res.writeHead(404); res.end(); return; }
  configRead = true;
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ ...settings, connectionMode: settings.connectionMode ?? 'direct', youtubeAuto: false,
    uiLocale: 'en', maxConcurrent: 1, siteRules: [], subtitles: { targetLang: null, textSize: 'medium', position: 'bottom' } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const configUrl = `http://127.0.0.1:${server.address().port}/${configToken}`;
const manifestPath = path.join(addon, 'manifest.json');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
manifest.host_permissions = [...new Set([...manifest.host_permissions, 'https://www.youtube.com/*', `${api.origin}/*`])];
// The disposable validation copy grants only the two required remote origins.
manifest.content_scripts = [{ matches: ['https://www.youtube.com/*'], js: ['validation-relay.js'], run_at: 'document_idle' }];
manifest.optional_permissions ??= [];
await fs.writeFile(manifestPath, JSON.stringify(manifest));
await fs.writeFile(path.join(addon, 'validation-relay.js'), `
window.addEventListener('message',event=>{
 if(event.source!==window||event.origin!==location.origin||event.data?.type!=='dual-read-validation:command')return;
 chrome.runtime.sendMessage(event.data.message,reply=>window.postMessage({type:'dual-read-validation:reply',id:event.data.id,reply,error:chrome.runtime.lastError?'extension-message-failed':undefined},location.origin));
});document.documentElement.dataset.dualReadValidation='ready';
`);
await fs.writeFile(path.join(addon, 'validation-ready.js'), "chrome.runtime.sendMessage({action:'validation:initialize'});");
const onboarding = path.join(addon, 'onboarding.html');
await fs.writeFile(onboarding, (await fs.readFile(onboarding, 'utf8')).replace('</body>', '<script src="validation-ready.js"></script></body>'));
const diagnostic = await build({ write: false, bundle: true, format: 'iife', target: 'es2022', stdin: { resolveDir: root, loader: 'ts', contents: `
import { probeYouTubeSource } from './lib/subtitles/youtube-adapter';
import { normalizeYouTubeEvents } from './lib/subtitles/normalize';
let initialized=false;const metrics=[];const nativeFetch=globalThis.fetch.bind(globalThis);
globalThis.fetch=async (input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
 if(url.origin!==${JSON.stringify(api.origin)}||!url.pathname.endsWith('/chat/completions'))return nativeFetch(input,init);
 if(metrics.length>=12)throw new Error('Live validation request budget exhausted');
 const row={index:metrics.length+1,start:Date.now(),status:0,elapsedMs:0,usage:null};metrics.push(row);
 try{const response=await nativeFetch(input,init);row.status=response.status;
   const body=await response.clone().json().catch(()=>null);row.usage=body?.usage??null;return response;
 }finally{row.elapsedMs=Date.now()-row.start;}
};
chrome.runtime.onMessage.addListener((m,s,reply)=>{
 if(m?.action==='validation:initialize'){
  if(!s.url?.startsWith(chrome.runtime.getURL(''))||initialized)return;
  initialized=true;
  (async()=>{const cfg=await nativeFetch(${JSON.stringify(configUrl)}).then(r=>r.json());
   const {apiKey,customHeaders,...sync}=cfg;
   await chrome.storage.session.set({apiKey});
   await chrome.storage.local.set({apiKey:'',customHeaders:customHeaders??{},youtubeAuto:false});
   await chrome.storage.sync.set({...sync,schemaVersion:5});
   return {success:true};
  })().then(reply,()=>reply({success:false,error:'configuration-failed'}));return true;
 }
 if(!s.tab?.id||s.frameId!==0||!s.url?.startsWith('https://www.youtube.com/watch?'))return;
 if(m?.action==='validation:metrics'){reply({initialized,requests:metrics});return;}
 if(m?.action==='validation:status'){chrome.tabs.sendMessage(s.tab.id,{action:'subtitle:status'},{frameId:0}).then(reply,()=>reply(null));return true;}
 if(m?.action==='validation:source'){
  (async()=>{const result=(await chrome.scripting.executeScript({target:{tabId:s.tab.id,frameIds:[0]},world:'MAIN',func:probeYouTubeSource,args:[m.options]}))[0].result;
   const {events,...safe}=result;const kind=result.tracks.find(t=>t.id===result.trackId)?.kind;
   const cues=events.length?normalizeYouTubeEvents(events,kind??'manual'):[];
   const words=text=>text.match(/[\\p{L}\\p{N}]+(?:['’][\\p{L}\\p{N}]+)*/gu)??[];
   const sourceWords=events.flatMap(e=>words(e.segs?.map(s=>s.utf8).join('')??''));const cueWords=cues.flatMap(c=>words(c.text));
   return {...safe,eventCount:events.length,textEventCount:events.filter(e=>e.segs?.some(s=>s.utf8.trim())).length,cueCount:cues.length,sourceWords:sourceWords.length,normalizedWords:cueWords.length,sameWords:JSON.stringify(sourceWords)===JSON.stringify(cueWords)};
  })().then(reply,()=>reply({error:'source-validation-failed'}));return true;
 }
});
` } });
const background = manifest.background.scripts[0];
await fs.appendFile(path.join(addon, background), '\n'+diagnostic.outputFiles[0].text);
const context = await withExtension(firefox, addon).launchPersistentContext(profile, { headless: false, viewport: { width: 1280, height: 820 }, firefoxUserPrefs: { 'media.volume_scale': '0.0' } });
await context.addInitScript(() => {
  const mute = node => {
    if (!(node instanceof Element)) return;
    const media = node.matches('video,audio') ? [node] : node.querySelectorAll('video,audio');
    for (const item of media) {
      if (!item.muted) item.muted = true;
      if (item.volume !== 0) item.volume = 0;
    }
  };
  for (const event of ['play', 'volumechange', 'loadstart', 'loadedmetadata', 'emptied']) {
    document.addEventListener(event, event => mute(event.target), true);
  }
  new MutationObserver(records => records.forEach(r => r.addedNodes.forEach(mute))).observe(document, { childList: true, subtree: true });
});
const page = context.pages().find(p => p.url()==='about:blank') ?? await context.newPage();
if (controlled) await installControlledSource(page, root);
await page.goto(`https://www.youtube.com/watch?v=${controlled ? 'aaaaaaaaaaa' : 'M7lc1UVf-VE'}`, { waitUntil: 'domcontentloaded' });
await page.bringToFront();
const out = value => console.log(JSON.stringify(value));
out({ready:true,browser:'firefox',version:context.browser()?.version(),profile,apiOrigin:api.origin,model:settings.model,requestBudget:12,controlledSource:controlled});
async function message(value) {
  await page.waitForFunction(()=>document.documentElement.dataset.dualReadValidation==='ready',undefined,{timeout:15000});
  return page.evaluate(message=>new Promise((resolve,reject)=>{
    const id=crypto.randomUUID();const timeout=setTimeout(()=>{window.removeEventListener('message',listen);reject(new Error('validation-timeout'));},20000);
    const listen=e=>{if(e.source!==window||e.data?.type!=='dual-read-validation:reply'||e.data.id!==id)return;clearTimeout(timeout);window.removeEventListener('message',listen);e.data.error?reject(new Error(e.data.error)):resolve(e.data.reply);};
    window.addEventListener('message',listen);window.postMessage({type:'dual-read-validation:command',id,message},location.origin);
  }),value);
}
async function state() {
  return page.evaluate(()=>{
    const p=document.querySelector('#movie_player'),v=p?.querySelector('video'),r=p?.getPlayerResponse?.(),t=p?.getOption?.('captions','track');
    const source=[...document.querySelectorAll('[data-dual-read-subtitle-ui]')].find(e=>e.shadowRoot?.querySelector('.source'))?.shadowRoot;
    return {signedIn:typeof window.ytcfg?.get('LOGGED_IN')==='boolean'?window.ytcfg.get('LOGGED_IN'):null,videoId:r?.videoDetails?.videoId??null,
      muted:v?.muted??null,volume:v?.volume??null,paused:v?.paused??null,time:v?.currentTime??null,readyState:v?.readyState??null,
      cc:p?.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed')??null,trackId:t?.vssId??t?.vss_id??null,
      nativeCharacters:[...p?.querySelectorAll('.ytp-caption-segment')??[]].reduce((n,e)=>n+(e.textContent?.length??0),0),
      sourceCharacters:source?.querySelector('.source')?.textContent?.length??0,translationCharacters:source?.querySelector('.line:not(.source)')?.textContent?.length??0};
  });
}
const history=[];
async function record(command,value){history.push({at:new Date().toISOString(),command,value});out({command,value});await fs.mkdir(path.join(root,'test-results/youtube-live'),{recursive:true});await fs.writeFile(path.join(root,'test-results/youtube-live/session.json'),JSON.stringify(history,null,2)+'\n');}
async function close(){await context.close().catch(()=>{});await new Promise(resolve=>server.close(resolve));await fs.rm(temporary,{recursive:true,force:true});}
if (controlled) {
  try { await runControlledValidation({ page, root, message, record, state }); }
  catch (error) { await record('controlled-failed', { passed: false, error: String(error.message).split('\n')[0].slice(0,160), metrics: await message({action:'validation:metrics'}).catch(()=>null) }); process.exitCode=1; }
  finally { await close(); }
} else {
const rl=readline.createInterface({input:process.stdin});
for await(const line of rl){
 try{
  const {command}=JSON.parse(line);
  if(command==='exit'){await close();break;}
  if(command==='status')await record(command,{page:await state(),extension:await message({action:'validation:status'})});
  else if(command==='metrics')await record(command,await message({action:'validation:metrics'}));
  else if(command==='source')await record(command,await message({action:'validation:source',options:{expectedVideoId:new URL(page.url()).searchParams.get('v'),enableNativeCC:true,timeoutMs:6000}}));
  else if(command==='start'||command==='stop')await record(command,await message({action:'subtitles:setEnabled',enabled:command==='start'}));
  else if(command==='shot'){
   const file=path.join(root,'test-results/youtube-live/player.png');await fs.mkdir(path.dirname(file),{recursive:true});await page.locator('#movie_player').screenshot({path:file});out({command,path:file});
  }
  else out({error:'unknown-command'});
 }catch(error){out({error:String(error.message).split('\n')[0].replace(/https?:\/\/\S+/g,'[url]').slice(0,160)});}
}
}
