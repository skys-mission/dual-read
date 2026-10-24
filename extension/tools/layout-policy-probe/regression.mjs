import {spawnSync} from 'node:child_process';
const output=process.argv.find(arg=>arg.startsWith('--output='))?.slice(9);
// Two restoration/mode combinations from every established layout family,
// plus every combination of the shared contract. Full suite stays available.
const grep='motion policy regression:|shared policy regression:|(?:nesting padding|logical nesting|specificity visibility|positioned layout|cascade layout|layout neighbor|inline visibility|media policy|stylesheet layout|flow style|layout policy|layout lifecycle|presentation layout|dynamic layout|review layout|generic page layout|generic feed layout).*?(?:bilingual,.*paused=true, delivered=false|replace,.*paused=false, delivered=true)|code content boundaries:';
const args=['playwright','test','--project=chromium-ext','--project=firefox-ext','--workers=2','--grep',grep,'--max-failures=1'];
args.push(...process.argv.slice(2).filter(arg=>!arg.startsWith('--output=')));
if(output)args.push('--reporter=json','--output='+output);
const r=spawnSync('npx',args,{stdio:'inherit',env:process.env});if(r.error)throw r.error;process.exit(r.status??1);
