// All application APIs are intercepted. No production writes, votes or prompts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const base = process.env.BASE_URL || 'http://127.0.0.1:3031';
const out = process.env.UI_ARTIFACTS || '/tmp/studio-ui-acceptance';
const checks = [];
const check = (name, ok) => { assert.ok(ok, name); checks.push(name); };
const limits = {max_pages:20,max_layers:30,max_image_mb:10,max_image_pixels:16000000,max_reference_images:5,plan_revisions:3,plan_user_rpm:3,plan_daily_requests:20,user_daily_jobs:10,user_queue_size:2,ppt_page_price:1,psd_task_price:1,retention_days:7};
const templateNames = {business:'雾白商务',product:'青绿产品',proposal:'暖砂方案',education:'晴蓝课堂'};
const templates = Object.entries(templateNames).map(([id,name])=>({id,name,description:'实际可编辑模板预览'}));
const slide = (title,layout='content')=>({title,layout,body:['测试正文'],image_index:null,chart_labels:[],chart_values:[],notes:''});
const planFor = kind=>({kind,title:kind==='ppt'?'测试演示':'测试分层',summary:'这是需要用户确认的制作方案',template_id:'business',fill_background:false,warnings:['没有原始隐藏像素，文字导出为像素层。'],slides:kind==='ppt'?[slide('封面','cover'),slide('内容'),slide('总结','closing')]:[],layers:kind==='psd'?[{name:'红色产品',kind:'subject',box:[100,200,300,500],polygon:[],text:''},{name:'标题',kind:'text',box:[100,50,600,150],polygon:[],text:'STUDIO DEMO'}]:[]});
const preview = fs.readFileSync(path.join(__dirname,'../public/studio-templates/business/slide-1.png'));
const upload = {name:'reference.png',mimeType:'image/png',buffer:preview};

(async()=>{
 fs.mkdirSync(out,{recursive:true});
 const browser = await chromium.launch({args:['--no-sandbox']});
 try {
  for (const width of [320,390,1366]) {
   const context = await browser.newContext({viewport:{width,height:844}});
   const page = await context.newPage(); page.setDefaultTimeout(12000);
   const errors=[],requests=[],submits=[],settingsWrites=[];
   page.on('pageerror',e=>errors.push(e.message));
   let trial={trial_id:'studio-2026-09',assigned_variant:'a',variant:'a',preference:null,seen_a:true,seen_b:false};
   let jobs=[],dropReply=true;
   let settings={...JSON.parse(fs.readFileSync(path.join(__dirname,'../../config.example.json'))),editable_studio:{...limits,enabled:true,reuse_optimizer_connection:true,base_url:'',api_key:'',has_api_key:true,model:'',protocol:'responses',reasoning_effort:'medium'}};
   await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url()),p=url.pathname;
    const api=['/v1/','/api/','/admin/api/','/auth/','/files/'].some(x=>p.startsWith(x))||p==='/app-config';
    if(!api) return url.origin===new URL(base).origin || url.protocol==='data:' ? route.continue() : route.abort();
    let body={};
    if(p==='/v1/user/ui-trial') {if(req.method()==='POST')trial={...trial,...req.postDataJSON()};body=trial;}
    else if(p==='/app-config')body={site_title:'测试工作室',quick_prompts:[]};
    else if(p==='/v1/key/info')body={remaining:100};
    else if(p==='/v1/editable-studio/config')body={enabled:true,limits,templates};
    else if(p==='/v1/editable-studio/plans'){
     const input=req.postDataJSON();requests.push(input);
     body={plan_id:'a'.repeat(32),plan:planFor(input.kind),revision:input.previous_plan_id?2:1,price:input.kind==='ppt'?3:1,expires_in:86400};
    } else if(p==='/v1/editable-studio/jobs') {
     if(req.method()==='POST'){
      const input=req.postDataJSON();submits.push(input);
      let job=jobs.find(j=>j.id===input.client_task_id);
      if(!job){job={id:input.client_task_id,kind:input.plan.kind,title:input.plan.title,price:input.expected_price,status:'running',phase:'AI 正在制作',error:'',elapsed_seconds:12,created_at:new Date().toISOString()};jobs.push(job);}
      if(dropReply){dropReply=false;return route.abort();}
      body=job;
     }else body={items:jobs};
    } else if(p.includes('/files/')||p.startsWith('/files/'))return route.fulfill({contentType:p.endsWith('.png')?'image/png':'application/octet-stream',body:preview});
    else if(p==='/v1/editable-file-tasks')body={items:[{id:'old-task',kind:'psd',status:'success',created_at:'2026-09-27',result:{primary_url:'/files/legacy/layers.psd'}}]};
    else if(p==='/api/settings'){
     if(req.method()!=='GET'){const payload=req.postDataJSON();settingsWrites.push(payload);settings=payload.config||payload;}
     body={config:settings};
    }else if(p==='/api/editable-studio/stats')body={daily_tokens:1234,jobs:[{status:'success',count:2}],recent:[]};
    else if(p==='/api/cpa/pools')body={pools:[]};
    else if(p==='/api/sub2api/servers')body={servers:[]};
    return route.fulfill({json:body});
   });
   await page.goto(base+'/editable-files/');
   await page.getByRole('heading',{name:'把想法，变成可用的文件'}).waitFor();
   await page.locator('.doc-template').last().waitFor();
   check('four-real-template-images-'+width,await page.locator('.doc-template img').evaluateAll(images=>images.length===4&&images.every(i=>i.complete&&i.naturalWidth>0)));
   for(const design of ['a','b']){
    await page.getByRole('button',{name:design==='a'?'切换到 A 雾白靛蓝':'切换到 B 石墨青绿',exact:true}).click();
    for(const mode of ['light','dark']){
     await page.getByLabel('明暗模式',{exact:true}).selectOption(mode);
     check('fits-'+width+'-'+design+'-'+mode,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
     if(width===390||width===1366)await page.screenshot({path:out+'/'+design+'-'+mode+'-'+width+'.png',fullPage:true});
    }
   }
   await page.getByLabel('主题、受众与必须包含的内容').fill('保留我的 PPT 草稿');
   await page.getByRole('tab',{name:'PSD 智能拆分'}).click();
   await page.getByLabel('要分开的元素，以及必须保留的细节').fill('分离产品和标题');
   await page.getByRole('tab',{name:'PPT 演示文稿'}).click();
   check('separate-drafts-'+width,await page.getByLabel('主题、受众与必须包含的内容').inputValue()==='保留我的 PPT 草稿');
   await page.getByLabel('PPT 页数').fill('3');
   await page.getByRole('button',{name:'帮我完善需求并生成方案',exact:true}).click();
   await page.getByLabel('第 1 页标题').waitFor();
   await page.getByRole('button',{name:'下移第 1 页',exact:true}).click();
   check('outline-reorder-'+width,await page.getByLabel('第 1 页标题').inputValue()==='内容');
   await page.getByLabel('第 1 页标题').fill('用户确认的标题');
   await page.getByLabel('第 1 页内容').fill('用户确认的要点');
   await page.getByRole('button',{name:'确认方案并生成',exact:true}).click();
   await page.locator('.doc-alert').waitFor();
   await page.getByRole('button',{name:'确认方案并生成',exact:true}).click();
   await page.getByRole('button',{name:'已提交制作',exact:true}).waitFor();
   check('lost-response-idempotency-'+width,submits.length===2&&submits[0].client_task_id===submits[1].client_task_id&&jobs.length===1);
   check('reviewed-content-submitted-'+width,submits[1].plan.slides[0].title==='用户确认的标题'&&submits[1].plan.slides[0].body[0]==='用户确认的要点');
   jobs[0]={...jobs[0],status:'success',phase:'文件已验收',result:{primary_url:'/v1/editable-studio/jobs/demo/files/presentation.pptx',zip_url:'/v1/editable-studio/jobs/demo/files/assets.zip',previews:['/v1/editable-studio/jobs/demo/files/slide-1.png'],warnings:[],editable_text:true}};
   await page.getByLabel('刷新文档任务').click();
   await page.getByRole('img',{name:'实际生成的第 1 页'}).waitFor();
   const downloaded=page.waitForEvent('download');
   await page.getByRole('button',{name:'下载 PPT',exact:true}).click();
   check('private-download-'+width,(await downloaded).suggestedFilename()==='presentation.pptx');
   await page.getByRole('button',{name:'新草稿',exact:true}).click();
   await page.getByLabel('主题、受众与必须包含的内容').fill('新草稿应该重新计次');
   await page.getByRole('button',{name:'帮我完善需求并生成方案',exact:true}).click();
   await page.getByLabel('第 1 页标题').waitFor();
   check('new-draft-resets-revision-'+width,requests[requests.length-1].previous_plan_id===null);
   await page.getByRole('tab',{name:'PSD 智能拆分'}).click();
   check('no-stale-ppt-delivery-in-psd-'+width,await page.locator('.doc-delivery').count()===0);
   await page.getByLabel('上传参考图').setInputFiles(upload);
   await page.getByRole('button',{name:'移除参考图 1',exact:true}).waitFor();
   await page.getByRole('button',{name:'帮我完善需求并生成方案',exact:true}).click();
   await page.getByLabel('图层 1 名称').waitFor();
   check('psd-geometry-overlay-'+width,await page.locator('.doc-layer-map svg rect').count()===2);
   await page.getByLabel('图层 1 名称').fill('独立商品');
   await page.getByLabel('图层 1 左',{exact:true}).fill('120');
   await page.getByRole('button',{name:'确认方案并生成',exact:true}).click();
   await page.getByRole('button',{name:'已提交制作',exact:true}).waitFor();
   check('psd-confirmed-geometry-'+width,submits.at(-1).plan.layers[0].box[0]===120&&submits.at(-1).plan.layers[0].name==='独立商品');
   await page.screenshot({path:out+'/psd-'+width+'.png',fullPage:true});
   await page.goto(base+'/admin/settings/');
   const card=page.locator('[data-slot=card]').filter({has:page.getByRole('heading',{name:'PPT / PSD 文档工作室 · 独立 API',exact:true})});
   await card.waitFor();
   await card.getByLabel('复用提示词优化的 API 地址、密钥、模型（不受其启用开关影响）').uncheck();
   await card.getByLabel('API Base URL（含 /v1）').fill('https://example.test/v1');
   await card.getByLabel('模型 ID').fill('test-model');
   check('admin-key-is-password-'+width,await card.getByLabel('API Key',{exact:true}).getAttribute('type')==='password');
   await card.locator('summary').click();
   await card.getByLabel('需求整理：每用户 RPM',{exact:true}).fill('1');
   await card.getByRole('button',{name:'保存工作室配置',exact:true}).click();
   await page.waitForTimeout(200);
   check('admin-saves-independent-config-'+width,(settingsWrites.at(-1)?.editable_studio||settingsWrites.at(-1)?.config?.editable_studio)?.plan_user_rpm===1);
   check('admin-fits-'+width,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   check('no-runtime-errors-'+width,errors.length===0);
   await context.close();
  }
 }finally{await browser.close();fs.writeFileSync(out+'/report.json',JSON.stringify({passed:checks.length,checks},null,2));console.log(JSON.stringify({passed:checks.length,checks},null,2));}
})().catch(error=>{console.error(error);process.exitCode=1;});
