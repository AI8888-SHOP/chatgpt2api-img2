// Runs plain JavaScript helpers and source checks; no TS transpilation/build.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=file=>fs.readFileSync(path.join(__dirname,'../src',file),'utf8');
test('image to video handoff is one-shot, expires and rejects unsupported files',async()=>{
  const {File}=require('node:buffer');
  const vm=require('node:vm');
  const values=new Map(),tokens=new Map();
  const context=vm.createContext({File,Date,crypto:require('node:crypto').webcrypto,setTimeout,clearTimeout,localforage:{createInstance:()=>({keys:async()=>[...values.keys()],getItem:async key=>values.get(key),setItem:async(key,value)=>values.set(key,value),removeItem:async key=>values.delete(key)})},sessionStorage:{getItem:key=>tokens.get(key),setItem:(key,value)=>tokens.set(key,value),removeItem:key=>tokens.delete(key)}});
  vm.runInContext(read('lib/video-reference-draft.js').replace('import localforage from "localforage";', '').replaceAll('export async function','async function'),context);
  const {stageVideoReference,takeVideoReference}=context;
  const file=new File(['image'],'reference.png',{type:'image/png'});
  await stageVideoReference(file);
  assert.equal(await (await takeVideoReference()).text(),'image');
  assert.equal(await takeVideoReference(),null);
  await assert.rejects(()=>stageVideoReference(new File(['GIF'],'image.gif',{type:'image/gif'})),/PNG/);
  await assert.rejects(()=>stageVideoReference(new File([new Uint8Array(5*1024*1024+1)],'large.png',{type:'image/png'})),/5 MB/);
  await stageVideoReference(file);
  const now=Date.now;
  try { Date.now=()=>now()+61000; assert.equal(await takeVideoReference(),null); } finally { Date.now=now; }
  assert.doesNotMatch(read('app/image/page.tsx'),/aria-label="创作类型"|<VideoWorkspace/);
  assert.match(read('app/image/components/image-results.tsx'),/图生视频/);
});
test('video pricing and fixed durations follow model switches',async()=>{
  const {videoCredits,allowedDuration}=await import('../src/lib/video-controls.js');
  assert.equal(videoCredits(12,5,'per_request'),12);
  assert.equal(videoCredits(12,15,'per_request'),12);
  assert.equal(videoCredits(12,5,'per_second'),60);
  assert.equal(videoCredits(12,5,undefined),60);
  assert.equal(allowedDuration({durations:[8],duration_default:8},5,15),8);
  assert.equal(allowedDuration({durations:[5,10,15],duration_default:15},15,10),5);
  assert.equal(allowedDuration({durations:[5,10],duration_default:5},10,10),10);
});
test('actual UI helpers enforce frame limits and discrete durations across model changes',async()=>{
  const {referenceLimit,allowedDuration}=await import('../src/lib/video-controls.js');
  const veo={protocol:'image2pro',supports_frame_control:true,supports_reference_images:false,max_reference_images:2,durations:[8],duration_default:8,min_duration:8};
  const omni={protocol:'image2pro',supports_frame_control:false,supports_reference_images:true,max_reference_images:3,durations:[15],duration_default:15,min_duration:15};
  assert.equal(referenceLimit(veo,'image',true),1);
  assert.equal(referenceLimit(veo,'reference',true),2);
  assert.equal(referenceLimit(omni,'reference',true),3);
  assert.equal(allowedDuration(omni,5,15),15);
  assert.equal(allowedDuration(veo,15,8),8);
  assert.equal(allowedDuration({...omni,durations:[4,6,8,10],duration_default:8},5,10),8);
  assert.equal(allowedDuration({protocol:'grok',min_duration:1},10,15),10);
});
test('navigation and independently authenticated pages expose real routes without collapsed labels',()=>{
  const nav=read('components/top-nav.tsx');
  assert.ok(nav.indexOf('href: "/video"')>nav.indexOf('href: "/image"'));
  assert.ok(nav.indexOf('href: "/video"')<nav.indexOf('href: "/editable-files"'));
  assert.ok(nav.indexOf('href: "/api-docs"')>nav.indexOf('href: "/api-keys"'));
  for(const page of ['api-docs','video']) assert.match(read(`app/${page}/page.tsx`),/<UserAccess>/);
  assert.match(read('components/user-access.tsx'),/fetchUserKeyInfo\(\)/);
  const sidebar=read('app/image/components/image-sidebar.tsx');
  assert.equal((sidebar.match(/href="\/image"/g)||[]).length,1);
  assert.match(sidebar,/!collapsed && "视频工作室"/);
  const workspace=read('app/image/components/video-workspace.tsx');
  assert.match(workspace,/setFrameMode\(false\); setExtendSource\(""\)/);
  assert.match(workspace,/clearReferences\(\); setMode\("text"\); setModelId/);
});
test('documentation uses real private API and does not advertise image resolution field',()=>{
  const doc=read('app/api-docs/page.tsx');
  for(const endpoint of ['/v1/video-models','/v1/images/generations','/v1/images/edits','/v1/videos/$TASK_ID/content']) assert.ok(doc.includes(endpoint));
  assert.ok(doc.includes('不是 resolution'));
  assert.ok(doc.includes('202'));
  assert.ok(doc.includes('unknown'));
  assert.ok(doc.includes('YOUR_PERSONAL_API_KEY'));
});
