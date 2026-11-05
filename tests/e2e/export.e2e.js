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
const conv=(id,name,extra={})=>({uuid:id,name,model:'claude-x',created_at:'2026-11-05T10:00:00Z',updated_at:'2026-11-05T10:00:00Z',settings:{},current_leaf_message_uuid:'m2-'+id,chat_messages:[
 {uuid:'m1-'+id,parent_message_uuid:null,sender:'human',created_at:'2026-11-05T10:00:00Z',content:[{type:'text',text:'hello '+name}],attachments:[],files:extra.files||[],files_v2:[]},
 {uuid:'m2-'+id,parent_message_uuid:'m1-'+id,sender:'assistant',created_at:'2026-11-05T10:00:01Z',content:extra.content||[{type:'text',text:'reply'}],attachments:[],files:[],files_v2:[]}]});
const server={
 [A]:conv(A,'Delivered chat',{files:[{success:true,file_kind:'blob',file_uuid:UP,file_name:'Uploaded.odt',download_source:'files-api'}],content:[{type:'text',text:'done'},
  {type:'tool_use',id:'p',name:'present_files',input:{filepaths:['/mnt/user-data/outputs/report.pdf']}},
  {type:'tool_result',tool_use_id:'p',name:'present_files',content:[{type:'local_resource',file_path:'/mnt/user-data/outputs/report.pdf',uuid:'',mime_type:'application/pdf',name:'report.pdf'}]},
  {type:'tool_use',id:'s1',name:'SendUserFile',input:{files:['/tmp/out/Minutes.odt']}},{type:'tool_result',tool_use_id:'s1',name:'SendUserFile',content:[{type:'text',text:'ok'}],file_deliveries:[{file_uuid:DEL1,path:'/tmp/out/Minutes.odt'}]},
  {type:'tool_use',id:'s2',name:'SendUserFile',input:{files:['/tmp/out/Minutes.odt']}},{type:'tool_result',tool_use_id:'s2',name:'SendUserFile',content:[{type:'text',text:'ok'}],file_deliveries:[{file_uuid:DEL2,path:'/tmp/out/Minutes.odt'}]}]}),
 [B]:conv(B,LONG+'1'),[C]:conv(C,LONG+'2')};
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'takeout-e2e-'));
 const ctx=await chromium.launchPersistentContext(dir,{headless:false,executablePath:process.env.CHROME_EXE,acceptDownloads:true,args:['--headless=new',`--disable-extensions-except=${EXT}`,`--load-extension=${EXT}`]});
 let failed=0;const check=(n,ok,x='')=>{if(!ok)failed++;console.log(`${ok?'PASS':'FAIL'}  ${n} ${ok?'':x}`)};
 try{
  await ctx.addCookies([{name:'lastActiveOrg',value:ORG,url:'https://claude.ai'}]);
  await ctx.route('https://claude.ai/**',(r)=>{const u=r.request().url();let m;
   if(m=u.match(/\/files\/([0-9a-f-]{36})\/contents$/)){const b={[DEL1]:bin,[DEL2]:bin2,[UP]:bin}[m[1]];return r.fulfill(b?{status:200,contentType:'application/octet-stream',body:b}:{status:404,json:{}})}
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
  [dl]=await Promise.all([panel.waitForEvent('download',{timeout:30000}),panel.click('#exportAllZip')]);
  const g=await zipFiles(await dl.path());const dirs=new Set(Object.keys(g).map(k=>k.split('/')[0]).filter(k=>!k.endsWith('.md')));
  check('same-prefix chats get separate folders',dirs.size===3,[...dirs].join(' ; '));console.log('      folders:',[...dirs].join(' ; '));
 }catch(e){failed++;console.log('HARNESS ERROR',e.message)}
 finally{await ctx.close();fs.rmSync(dir,{recursive:true,force:true})}
 console.log(failed?`\n${failed} failed`:'\nall passed');process.exit(failed?1:0)
})();
