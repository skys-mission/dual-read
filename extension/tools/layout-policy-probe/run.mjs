import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium,firefox} from 'playwright';
const dir=path.dirname(fileURLToPath(import.meta.url)),temporary=await fs.mkdtemp(path.join(os.tmpdir(),'dual-read-policy-'));
const output=process.argv.find(arg=>arg.startsWith('--output='))?.slice(9),rows=[];
const modes=[['horizontal-tb','ltr',['top','bottom','left','right']],['horizontal-tb','rtl',['top','bottom','right','left']],['vertical-rl','ltr',['right','left','top','bottom']],['vertical-rl','rtl',['right','left','bottom','top']],['vertical-lr','ltr',['left','right','top','bottom']],['vertical-lr','rtl',['left','right','bottom','top']],['sideways-rl','ltr',['right','left','top','bottom']],['sideways-rl','rtl',['right','left','bottom','top']],['sideways-lr','ltr',['left','right','bottom','top']],['sideways-lr','rtl',['left','right','top','bottom']]];
try {
 await build({entryPoints:[path.join(dir,'entry.ts')],bundle:true,format:'iife',platform:'browser',outfile:path.join(temporary,'probe.js')});
 for(const engine of ['chromium','firefox']) {
  const browser=await({chromium,firefox})[engine].launch({headless:true});
  try {
   const page=await browser.newPage({viewport:{width:1920,height:1080}});await page.goto('about:blank');await page.addScriptTag({path:path.join(temporary,'probe.js')});
   for(const[writingMode,direction,sides]of modes)for(const[index,edge]of ['block-start','block-end','inline-start','inline-end'].entries())for(const family of ['padding','margin','inset','border'])for(const operation of ['specificity','order','shorthand','variable']) {
    const physical=family==='inset'?sides[index]:`${family}-${sides[index]}${family==='border'?'-width':''}`,logical=`${family}-${edge}${family==='border'?'-width':''}`;
    const result=await page.evaluate(({writingMode,direction,physical,logical,family,operation})=>{
     document.body.innerHTML='<main class="high active" id="shell"><section class="bounded" id="box"></section></main>';document.documentElement.className='';document.querySelectorAll('style').forEach(s=>s.remove());
     const shorthand=family==='border'?logical.replace(/-(start|end)-width$/,'-width'):logical.replace(/-(start|end)$/,''),property=operation==='shorthand'||operation==='variable'?shorthand:logical,value=operation==='variable'?'var(--value)':'20px';
     const css=operation==='specificity'?`.high.active #box{${physical}:20px}:where(.low) #box{${physical}:20px}#box.bounded{${logical}:0px}`:`#box{${physical}:0px;${property}:${value}}`;
     const sheet=document.createElement('style');sheet.textContent=`#box{writing-mode:${writingMode};direction:${direction};position:relative;width:120px;height:120px;border-style:solid;border-width:0;--value:20px}`+css;document.head.append(sheet);
     const box=document.getElementById('box'),properties=[physical,property],api=window.layoutPolicyProbe;
     const read=()=>{const p=api.readSourceLayoutPolicyState(box,properties);return {value:getComputedStyle(box).getPropertyValue(physical),fingerprint:JSON.stringify([p.signature,p.complete?null:api.readComputedSizing(box,properties)])};};
     const before=read();if(operation==='specificity')document.getElementById('shell').className='low';else sheet.textContent=sheet.textContent.replace(`${physical}:0px;${property}:${value}`,`${property}:${value};${physical}:0px`);const after=read();
     return {before,after,changed:before.fingerprint!==after.fingerprint,markers:document.querySelectorAll('[data-dual-read-sizing-probe],style[data-dual-read-sizing-style]').length};
    },{writingMode,direction,physical,logical,family,operation});
    assert.equal(result.before.value,'20px',JSON.stringify({engine,family,operation,result}));assert.equal(result.after.value,'0px');assert(result.changed,JSON.stringify({engine,family,operation,result}));assert.equal(result.markers,0);rows.push({engine,writingMode,direction,physical,logical,family,operation,...result});
   }
   for(const selector of ['&.high #box',':is(&).high #box',':where(&).high #box','&.high #box,&.high #unused']) {
    const result=await page.evaluate(selector=>{
     document.body.innerHTML='<p id="box"></p>';document.querySelectorAll('style').forEach(s=>s.remove());document.documentElement.className='high';const sheet=document.createElement('style');sheet.textContent=`#box{height:50px}${selector}{height:80px}`;document.head.append(sheet);
     const box=document.getElementById('box'),api=window.layoutPolicyProbe,rule=sheet.sheet.cssRules[1],r=api.resolveRootSelector(rule,rule.selectorText),before=api.readSourceLayoutPolicyState(box,['height']);const initial=getComputedStyle(box).height,weight=api.matchingSpecificity(rule,r.selector,box);document.documentElement.className='low';return {initial,current:getComputedStyle(box).height,weight,changed:before.signature!==api.readSourceLayoutPolicyState(box,['height']).signature};
    },selector);assert.equal(result.initial,'80px');assert.equal(result.current,'50px');assert.deepEqual(result.weight,[1,1,0]);assert(result.changed);rows.push({engine,family:'root-scope',selector,...result});
   }
   for(const context of ['scope-rule','shadow-host','document-scope']) {
    const result=await page.evaluate(context=>{
     document.body.innerHTML='<main class="high" id="shell"></main>';document.documentElement.className='high';document.querySelectorAll('style').forEach(s=>s.remove());
     const shell=document.getElementById('shell');let container=document,rule=':scope.high #box{height:80px}';
     if(context==='shadow-host'){container=shell.attachShadow({mode:'open'});container.innerHTML='<p id="box"></p>';rule=':host(.high) #box{height:80px}';}
     else {shell.innerHTML='<p id="box"></p>';if(context==='scope-rule')rule='@scope (.high){& #box{height:80px}}';}
     const style=document.createElement('style');style.textContent='#box{height:50px}'+rule;(container===document?document.head:container).append(style);const box=container.querySelector('#box'),api=window.layoutPolicyProbe;
     const read=()=>{const p=api.readSourceLayoutPolicyState(box,['height']);return {height:getComputedStyle(box).height,complete:p.complete,fingerprint:JSON.stringify([p.signature,p.complete?null:api.readComputedSizing(box,['height'])])};};
     const before=read();shell.className='low';document.documentElement.className='low';const after=read();return {before,after,changed:before.fingerprint!==after.fingerprint};
    },context);assert.equal(result.before.height,'80px');assert.equal(result.after.height,'50px');assert.equal(result.before.complete,false);assert(result.changed);rows.push({engine,family:'context-fallback',context,...result});
   }
   for(const[writingMode,direction]of modes)for(const property of ['height','min-height','max-height','block-size','padding-top','border-top-width']) {
    const result=await page.evaluate(({writingMode,direction,property})=>{
     document.body.innerHTML='<main id="parent"><section id="box"></section></main>';document.querySelectorAll('style').forEach(s=>s.remove());document.documentElement.className='';
     const parentProperty=property==='block-size'?/^(vertical|sideways)-/.test(writingMode)?'width':'height':property;
     const sheet=document.createElement('style');sheet.textContent=`#parent{border-style:solid;border-width:0;${parentProperty}:80px}#box{display:block;width:120px;height:120px;border-style:solid;border-width:0;writing-mode:${writingMode};direction:${direction};${property}:inherit}`;document.head.append(sheet);
     const box=document.getElementById('box'),parent=document.getElementById('parent'),api=window.layoutPolicyProbe,read=()=>({value:getComputedStyle(box).getPropertyValue(property),signature:api.readSourceLayoutPolicyState(box,[property]).signature});
     const before=read();parent.style.color='red';const paint=read();parent.style.setProperty(parentProperty,'50px');const after=read();return {before,after,changed:before.signature!==after.signature,paintStable:before.signature===paint.signature};
    },{writingMode,direction,property});assert.equal(result.before.value,'80px',JSON.stringify({engine,writingMode,direction,property,before:result.before.value}));assert.equal(result.after.value,'50px');assert(result.changed);assert(result.paintStable);rows.push({engine,family:'inheritance',writingMode,direction,property,...result});
   }
   for(const property of ['height','blockSize','minHeight','borderBlockStartWidth','color','opacity','transform','width']) {
    const result=await page.evaluate(property=>{
     document.body.innerHTML='<section id="box"></section>';document.querySelectorAll('style').forEach(s=>s.remove());const sheet=document.createElement('style');sheet.textContent='#box{display:block;width:120px;height:80px;border-style:solid}';document.head.append(sheet);
     const box=document.getElementById('box'),api=window.layoutPolicyProbe,properties=['height','min-height','border-top-width'],before=api.readSourceLayoutPolicyState(box,properties);
     const animation=box.animate([{[property]:property==='color'?'red':property==='opacity'?'1':property==='transform'?'translateX(0)':'80px'},{[property]:property==='color'?'blue':property==='opacity'?'0.5':property==='transform'?'translateX(10px)':'50px'}],{duration:1000,fill:'forwards'});animation.pause();animation.currentTime=0;
     const first=api.readSourceLayoutPolicyState(box,properties);animation.currentTime=1000;const filled=api.readSourceLayoutPolicyState(box,properties);animation.cancel();const canceled=api.readSourceLayoutPolicyState(box,properties);
     return {before,first,filled,canceled,controlled:!!first.animated,stableTime:first.signature===filled.signature,restored:before.signature===canceled.signature};
    },property);assert.equal(result.controlled,['height','blockSize','minHeight','borderBlockStartWidth'].includes(property));assert(result.stableTime);assert(result.restored);rows.push({engine,family:'motion',property,...result});
   }
  } finally {await browser.close();}
 }
 if(output)await fs.writeFile(path.resolve(output),JSON.stringify(rows,null,2));console.log(JSON.stringify({cases:rows.length,engines:2,allPassed:true}));
} finally {await fs.rm(temporary,{recursive:true,force:true});}
