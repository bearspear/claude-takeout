// Real extension in Chromium against a mock claude.ai: binary bytes through real ZIP exports.
const { chromium } = require(process.env.PW);
const fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto');
const EXT=path.resolve(__dirname,'..','..');
const ORG='11111111-1111-4111-8111-111111111111';
const A='aaaaaaaa-0000-4000-8000-000000000001',B='bbbbbbbb-0000-4000-8000-000000000002',C='cccccccc-0000-4000-8000-000000000003';
const DEL1='d1d1d1d1-0000-4000-8000-000000000001',DEL2='d2d2d2d2-0000-4000-8000-000000000002',UP='e1e1e1e1-0000-4000-8000-000000000001';
const bin=Buffer.alloc(4096);for(let i=0;i<bin.length;i++)bin[i]=(i*7+200)&255;bin.write('%PDF-1.4',0);
const bin2=Buffer.from(bin);bin2[100]=1;
const sha=b=>crypto.createHash('sha1').update(b).digest('hex');
const LONG='Hierarchies of being and mathematical structures - Part ';
const PROJ='a0a0a0a0-0000-4000-8000-000000000001',PF='f0f0f0f0-0000-4000-8000-000000000001';
const conv=(id,name,extra={})=>({uuid:id,name,model:'claude-x',created_at:'2026-11-05T10:00:00Z',updated_at:'2026-11-05T10:00:00Z',settings:{},current_leaf_message_uuid:'m2-'+id,chat_messages:[
 {uuid:'m1-'+id,parent_message_uuid:null,sender:'human',created_at:'2026-11-05T10:00:00Z',content:[{type:'text',text:'hello '+name}],attachments:[],files:extra.files||[],files_v2:[]},
 {uuid:'m2-'+id,parent_message_uuid:'m1-'+id,sender:'assistant',created_at:'2026-11-05T10:00:01Z',content:extra.content||[{type:'text',text:'reply'}],attachments:[],files:[],files_v2:[]}]});
const server={
 [A]:conv(A,'Delivered chat',{files:[{success:true,file_kind:'blob',file_uuid:UP,file_name:'Uploaded.odt',download_source:'files-api'}],content:[{type:'text',text:'done'},
  {type:'tool_use',id:'p',name:'present_files',input:{filepaths:['/mnt/user-data/outputs/report.pdf']}},
  {type:'tool_result',tool_use_id:'p',name:'present_files',content:[{type:'local_resource',file_path:'/mnt/user-data/outputs/report.pdf',uuid:'',mime_type:'application/pdf',name:'report.pdf'}]},
  {type:'tool_use',id:'s1',name:'SendUserFile',input:{files:['/tmp/out/Minutes.odt']}},{type:'tool_result',tool_use_id:'s1',name:'SendUserFile',content:[{type:'text',text:'ok'}],file_deliveries:[{file_uuid:DEL1,path:'/tmp/out/Minutes.odt'}]},
  {type:'tool_use',id:'s2',name:'SendUserFile',input:{files:['/tmp/out/Minutes.odt']}},{type:'tool_result',tool_use_id:'s2',name:'SendUserFile',content:[{type:'text',text:'ok'}],file_deliveries:[{file_uuid:DEL2,path:'/tmp/out/Minutes.odt'}]}]}),
 [B]:Object.assign(conv(B,LONG+'1'),{project_uuid:PROJ}),[C]:Object.assign(conv(C,LONG+'2'),{project_uuid:PROJ})};
let projectDownloads=0;
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'takeout-e2e-'));
 const ctx=await chromium.launchPersistentContext(dir,{headless:false,executablePath:process.env.CHROME_EXE,acceptDownloads:true,args:['--headless=new',`--disable-extensions-except=${EXT}`,`--load-extension=${EXT}`]});
 let failed=0;const check=(n,ok,x='')=>{if(!ok)failed++;console.log(`${ok?'PASS':'FAIL'}  ${n} ${ok?'':x}`)};
 try{
  await ctx.addCookies([{name:'lastActiveOrg',value:ORG,url:'https://claude.ai'}]);
  await ctx.route('https://claude.ai/**',(r)=>{const u=r.request().url();let m;
   if(u.endsWith(`/files/${PF}/contents`)){projectDownloads++;return r.fulfill({status:200,contentType:'application/pdf',body:bin})}
   if(m=u.match(/\/files\/([0-9a-f-]{36})\/contents$/)){const b={[DEL1]:bin,[DEL2]:bin2,[UP]:bin}[m[1]];return r.fulfill(b?{status:200,contentType:'application/octet-stream',body:b}:{status:404,json:{}})}
   if(u.endsWith(`/projects/${PROJ}`))return r.fulfill({json:{name:'Shared Project',docs_count:0,files_count:1}});
   if(u.endsWith(`/projects/${PROJ}/docs`))return r.fulfill({json:[]});
   if(u.endsWith(`/projects/${PROJ}/files`))return r.fulfill({json:[{file_uuid:PF,file_name:'Paper.pdf'}]});
   if(u.includes('/wiggle/download-file'))return r.fulfill({status:200,contentType:'application/pdf',body:bin});
   if(m=u.match(/chat_conversations\/([0-9a-f-]{36})/))return r.fulfill(server[m[1]]?{json:server[m[1]]}:{status:404,json:{}});
   if(/\/chat_conversations(\?|$)/.test(u))return r.fulfill({json:Object.values(server).map(c=>({uuid:c.uuid,name:c.name,updated_at:c.updated_at}))});
   if(u.includes('/api/'))return r.fulfill({status:404,json:{}});
   return r.fulfill({contentType:'text/html',body:'<!doctype html><title>m</title>mock'})});
  const claude=await ctx.newPage();await claude.goto(`https://claude.ai/chat/${A}`);await claude.waitForTimeout(800);
  const sw=ctx.serviceWorkers()[0]||await ctx.waitForEvent('serviceworker');const id=new URL(sw.url()).host;
  const pp=ctx.waitForEvent('page',p=>p.url().includes('sidepanel.html'));
  await sw.evaluate(u=>chrome.windows.create({url:u,focused:false}),`chrome-extension://${id}/sidepanel.html`);
  const panel=await pp;await panel.waitForLoadState('load');await panel.waitForTimeout(300);
  await panel.evaluate(()=>{const real=chrome.tabs.query.bind(chrome.tabs);chrome.tabs.query=async()=>(await real({url:'https://claude.ai/*'})).slice(0,1);return requestData()});
  await panel.waitForTimeout(600);
  const zipFiles=async(p)=>panel.evaluate(async b64=>{const z=await JSZip.loadAsync(Uint8Array.from(atob(b64),c=>c.charCodeAt(0)));const o={};for(const n of Object.keys(z.files)){if(z.files[n].dir)continue;const u=await z.files[n].async('uint8array');o[n]=Array.from(u.slice(0,8)).join(',')+'|'+u.length+'|'+(await crypto.subtle.digest('SHA-1',u).then(h=>[...new Uint8Array(h)].map(x=>x.toString(16).padStart(2,'0')).join('')))}return o},fs.readFileSync(p).toString('base64'));
  let [dl]=await Promise.all([panel.waitForEvent('download',{timeout:20000}),panel.click('#exportZip')]);
  const f=await zipFiles(await dl.path());const h=n=>{const k=Object.keys(f).find(x=>x.endsWith(n));return k&&f[k].split('|')[2]};
  check('presented PDF bytes intact',h('artefacts/report.pdf')===sha(bin));
  check('delivered v1 intact',h('artefacts/Minutes_v1.odt')===sha(bin));
  check('delivered v2 intact',h('artefacts/Minutes_v2.odt')===sha(bin2));
  check('delivered final is latest',h('artefacts/Minutes.odt')===sha(bin2));
  check('files-api upload saved',h('uploads/p01_Uploaded.odt')===sha(bin));
  check('no errors.txt',!Object.keys(f).some(k=>k.endsWith('errors.txt')),Object.keys(f).join());
  const viewerOf=async p=>panel.evaluate(async b64=>{const z=await JSZip.loadAsync(Uint8Array.from(atob(b64),c=>c.charCodeAt(0)));const html=await z.file('viewer.html').async('string');const data=JSON.parse(html.match(/<script id="data"[^>]*>([\s\S]*?)<\/script>/)[1]);return{data,names:Object.keys(z.files),gif:await z.file('viewer-check.gif').async('base64')}},fs.readFileSync(p).toString('base64'));
  const sv=await viewerOf(await dl.path());
  const rootGif=await panel.evaluate(()=>CTViewer.VIEWER_CHECK_BASE64);
  check('single ZIP: viewer.html and viewer-check.gif at root',f['viewer.html']&&f['viewer-check.gif']&&sv.gif===rootGif);
  check('single ZIP: one chat in the viewer',sv.data.chats.length===1&&sv.data.chats[0].title==='Delivered chat');
  const sm=Object.values(sv.data.chats[0].files).find(x=>x.name==='Minutes.odt');
  check('single ZIP: each delivered version links its own file',sm&&sm.versions.map(v=>v.href).join()==='artefacts/Minutes_v1.odt,artefacts/Minutes_v2.odt',JSON.stringify(sm));
  check('single ZIP: upload links its file',sv.data.chats[0].messages[0].uploads[0].href==='uploads/p01_Uploaded.odt');
  check('single ZIP: status is clean',(await panel.$eval('#status',s=>s.className)).includes('ready'),await panel.textContent('#status'));
  [dl]=await Promise.all([panel.waitForEvent('download',{timeout:30000}),panel.click('#exportAllZip')]);
  const g=await zipFiles(await dl.path());const dirs=new Set(Object.keys(g).filter(k=>k.includes('/')).map(k=>k.split('/')[0]).filter(k=>k!=='projects'));
  const shared=Object.keys(g).filter(k=>k.endsWith('Paper.pdf'));
  check('project file stored once with intact bytes',shared.length===1&&shared[0]==='projects/Shared_Project/files/Paper.pdf'&&g[shared[0]].split('|')[2]===sha(bin),shared.join());
  check('project file downloaded once',projectDownloads===1,String(projectDownloads));
  check('no errors.txt for project chats',!Object.keys(g).some(k=>k.endsWith('errors.txt')));
  const mv=await viewerOf(await dl.path());
  check('mega-ZIP: one viewer at the root',Object.keys(g).filter(k=>k.endsWith('viewer.html')).join()==='viewer.html'&&Object.keys(g).filter(k=>k.endsWith('viewer-check.gif')).join()==='viewer-check.gif');
  check('mega-ZIP: the viewer has every chat',mv.data.chats.length===3,String(mv.data.chats.length));
  const hrefs=[];for(const c of mv.data.chats){for(const m of c.messages)for(const u of m.uploads)hrefs.push(u.href);for(const x of Object.values(c.files))for(const v of x.versions)hrefs.push(v.href);for(const x of mv.data.projects[c.project]?.files||[])hrefs.push(x.href)}
  check('mega-ZIP: a shared project is stored once in the viewer',mv.data.projects.length===1&&mv.data.chats.filter(c=>c.project===0).length===2&&JSON.stringify(mv.data).split('"Shared Project"').length===2,JSON.stringify(mv.data.chats.map(c=>c.project)));
  check('mega-ZIP: every link lands on a file',hrefs.length>=6&&hrefs.every(h=>h&&decodeURIComponent(h) in g),hrefs.join());
  check('mega-ZIP: uploaded binary unchanged',g[Object.keys(g).find(k=>k.endsWith('uploads/p01_Uploaded.odt'))].split('|')[2]===sha(bin));
  check('mega-ZIP: status is clean',(await panel.$eval('#status',s=>s.className)).includes('ready'),await panel.textContent('#status'));
  // Review Focus 4: a viewer failure leaves the ZIP complete and says so.
  const baseFiles=Object.keys(f).filter(k=>!/^viewer/.test(k)).sort().join();
  await panel.evaluate(()=>{CTViewer.assembleViewer=()=>{throw new Error('boom')}});
  [dl]=await Promise.all([panel.waitForEvent('download',{timeout:20000}),panel.click('#exportZip')]);
  const nf=await zipFiles(await dl.path());
  check('broken viewer: single ZIP still complete',Object.keys(nf).sort().join()===baseFiles,Object.keys(nf).sort().join());
  await panel.waitForFunction(()=>document.getElementById('status').textContent.includes('viewer.html could not be built'),null,{timeout:5000});
  check('broken viewer: single ZIP status is amber',(await panel.$eval('#status',s=>s.className)).includes('warning'),await panel.textContent('#status'));
  [dl]=await Promise.all([panel.waitForEvent('download',{timeout:30000}),panel.click('#exportAllZip')]);
  const ng=await zipFiles(await dl.path());
  check('broken viewer: mega-ZIP still complete',Object.keys(ng).filter(k=>!k.endsWith('index.md')).sort().join()===Object.keys(g).filter(k=>!/^viewer/.test(k)&&!k.endsWith('index.md')).sort().join());
  await panel.waitForFunction(()=>document.getElementById('status').textContent.includes('viewer.html could not be built'),null,{timeout:5000});
  check('broken viewer: mega-ZIP status is amber',(await panel.$eval('#status',s=>s.className)).includes('warning'),await panel.textContent('#status'));
  check('same-prefix chats get separate folders',dirs.size===3,[...dirs].join(' ; '));console.log('      folders:',[...dirs].join(' ; '));
 }catch(e){failed++;console.log('HARNESS ERROR',e.message)}
 finally{await ctx.close();fs.rmSync(dir,{recursive:true,force:true})}
 console.log(failed?`\n${failed} failed`:'\nall passed');process.exit(failed?1:0)
})();
