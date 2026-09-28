// All APIs are intercepted. Never sends real prompts, votes or settings writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const base = process.env.BASE_URL || 'http://127.0.0.1:3031';
const out = process.env.UI_ARTIFACTS || '/tmp/ui-trial-tests';
const pixel = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420"><rect width="640" height="420" fill="#bfd7c9"/><circle cx="430" cy="120" r="50" fill="#fff2c4"/><path d="M0 420L200 120L420 420M240 420L440 210L640 420" fill="#6e9383"/></svg>');
const rounds = [0,1].map(i => ({ id: 'turn-'+i, threadId:'turn-0', title:'山间静舍', prompt:'第 '+(i+1)+' 轮：柔和的光与浅绿色植物', mode:'generate', model:'gpt-image-2', count:1, status:'success', createdAt:new Date(Date.UTC(2026,8,28,12,i)).toISOString(), images:[{id:'img-'+i,status:'success',url:pixel}] }));
const fresh = variant => ({trial_id:'studio-2026-09',assigned_variant:variant,variant,preference:null,seen_a:false,seen_b:false});
const checks = [];
const check = (name,value) => {assert.ok(value,name);checks.push(name);};

(async()=>{
 fs.mkdirSync(out,{recursive:true});
 const browser=await chromium.launch({args:['--no-sandbox']});
 try {
  for(const width of [320,390,1366]) {
   const context=await browser.newContext({viewport:{width,height:width===320?568:844}});
   const page=await context.newPage();page.setDefaultTimeout(12000);
   const errors=[];page.on('pageerror',e=>errors.push(e.message));
   let trial=fresh('a'),failSave=false;const posts=[];
   await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url()),p=url.pathname;
    const api=['/v1/','/api/','/admin/api/','/auth/'].some(prefix=>p.startsWith(prefix))||p==='/app-config';
    if(!api) return url.origin===new URL(base).origin || url.protocol==='data:' ? route.continue() : route.abort();
    let body={};
    if(p==='/v1/user/ui-trial') {
     if(req.method()==='POST') {
      const b=req.postDataJSON();posts.push(b);
      if(failSave)return route.fulfill({status:503,json:{error:'试用服务暂不可用'}});
      if(b.variant){trial.variant=b.variant;trial['seen_'+b.variant]=true;}
      if(Object.hasOwn(b,'preference'))trial.preference=b.preference;
     }
     body=trial;
    }else if(p==='/app-config')body={site_title:'image 绘图',quick_prompts:[]};
    else if(p==='/v1/key/info')body={remaining:100};
    else if(p==='/v1/image-conversations')body=req.method()==='GET'?{items:rounds}:{success:true,conversation:req.postDataJSON()?.conversation};
    else if(p==='/v1/image-prompts/optimize') {await new Promise(r=>setTimeout(r,600));body={optimized_prompt:'优化后的自然庭院与柔光'};}
    else if(p==='/api/ui-trial/stats')body={trial_id:'studio-2026-09',days:7,participants:2,active_users:2,tried_both:1,votes:{a:0,b:1,equal:0},not_voted:1,started_at:1790596800,variants:[{variant:'a',assigned:1,experienced:2,current:1,active_current:1,preferred:0,preferred_by_cohort:{a:0,b:0}},{variant:'b',assigned:1,experienced:1,current:1,active_current:1,preferred:1,preferred_by_cohort:{a:1,b:0}}]};
    else if(p.includes('jobs'))body={items:[],status:'error',error:'No real generation in UI tests'};
    return route.fulfill({json:body});
   });
   await page.goto(base+'/image/');
   const a=page.getByRole('button',{name:'切换到 A 雾白靛蓝',exact:true}),b=page.getByRole('button',{name:'切换到 B 石墨青绿',exact:true});
   await page.waitForFunction(()=>document.querySelector('[aria-label="切换到 B 石墨青绿"]')?.disabled===false);
   await page.getByRole('button',{name:'界面试用与偏好投票'}).click();
   check('no-voting-before-both-'+width,await page.getByRole('button',{name:'更喜欢 A',exact:true}).isDisabled());
   await page.keyboard.press('Escape');
   if(width<1024) await page.getByRole('button',{name:'打开历史记录',exact:true}).click();
   await page.getByRole('button',{name:'山间静舍',exact:true}).filter({visible:true}).click();
   await page.getByRole('button',{name:'复用并继续对话',exact:true}).last().click();
   await page.getByRole('button',{name:'编辑图',exact:true}).click();
   await page.locator('input[type=file]').setInputFiles({name:'reference.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')});
   await page.getByLabel('图像提示词').fill('切换时保留我的草稿');
   await page.evaluate(()=>window.__draftNode=document.querySelector('textarea'));
   await b.click();
   await page.locator('.studio-workspace[data-layout=b]').waitFor();
   check('draft-preserved-'+width,await page.getByLabel('图像提示词').inputValue()==='切换时保留我的草稿');
   check('composer-not-remounted-'+width,await page.evaluate(()=>window.__draftNode===document.querySelector('textarea')));
   check('reference-and-thread-preserved-'+width,await page.getByRole('button',{name:'移除参考图 1',exact:true}).isVisible() && await page.getByText('继续当前对话 · 已有 2 轮',{exact:true}).isVisible());
   await page.getByRole('button',{name:'第 1 轮',exact:true}).click();
   await page.waitForFunction(()=>document.querySelector('[data-testid=image-results-scroll]').scrollTop===0);
   check('canvas-round-starts-at-image-'+width,await page.getByRole('button',{name:'查看结果图 1',exact:true}).isVisible());
   check('canvas-round-selector-'+width,(await page.locator('.whitespace-pre-wrap').textContent()).includes('第 1 轮'));
   await page.screenshot({path:out+'/b-'+width+'.png',fullPage:true});
   await a.click();await page.locator('.studio-workspace[data-layout=a]').waitFor();
   check('conversation-all-rounds-'+width,await page.locator('.whitespace-pre-wrap').count()===2);
   await page.screenshot({path:out+'/a-'+width+'.png',fullPage:true});
   await page.getByRole('button',{name:'AI 优化提示词',exact:true}).click();
   await b.click();await page.locator('.studio-workspace[data-layout=b]').waitFor();
   await page.waitForTimeout(800);
   check('pending-optimization-survives-switch-'+width,await page.getByLabel('图像提示词').inputValue()==='优化后的自然庭院与柔光');
   await page.getByRole('button',{name:'界面试用与偏好投票'}).click();
   await page.getByRole('button',{name:'更喜欢 B',exact:true}).click();
   await page.getByText('偏好已保存',{exact:true}).waitFor();
   check('vote-saved-'+width,trial.preference==='b');
   await page.getByRole('button',{name:'更喜欢 A',exact:true}).click();
   await page.waitForFunction(()=>document.querySelector('.design-votes button[aria-pressed=true]')?.textContent==='更喜欢 A');
   check('vote-replaced-'+width,trial.preference==='a');
   await page.screenshot({path:out+'/vote-'+width+'.png',fullPage:true});
   await page.getByRole('button',{name:'撤回投票',exact:true}).click();
   await page.getByText('偏好已保存',{exact:true}).waitFor({state:'hidden'});
   check('vote-withdrawn-'+width,trial.preference===null);
   await page.keyboard.press('Escape');
   await page.reload();await page.locator('.studio-workspace[data-layout=b]').waitFor();
   check('server-choice-restored-'+width,await page.locator('html').getAttribute('data-design')==='b');
   await page.waitForFunction(()=>document.querySelector('[aria-label="切换到 A 雾白靛蓝"]')?.disabled===false);
   failSave=true;await a.click();
   await page.locator('.design-error-dot').waitFor();
   check('failed-save-not-falsely-applied-'+width,await page.locator('html').getAttribute('data-design')==='b');
   failSave=false;await a.click();await page.locator('.studio-workspace[data-layout=a]').waitFor();
   for(const mode of ['dark','light']){await page.getByLabel('明暗模式',{exact:true}).selectOption(mode);check('no-horizontal-overflow-'+width+'-'+mode,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
   check('no-prompt-in-trial-payloads-'+width,posts.every(p=>Object.keys(p).every(k=>['variant','preference'].includes(k))));
   await page.goto(base+'/admin/ui-trial/');
   await page.getByRole('heading',{name:'界面试用',exact:true}).waitFor();await page.getByText('明确偏好票数').first().waitFor();
   check('admin-summary-fits-'+width,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   await page.screenshot({path:out+'/admin-'+width+'.png',fullPage:true});
   check('no-runtime-errors-'+width,errors.length===0);
   await context.close();
  }
 }finally{await browser.close();fs.writeFileSync(out+'/report.json',JSON.stringify(checks,null,2));console.log(JSON.stringify({passed:checks.length,checks},null,2));}
})().catch(error=>{console.error(error);process.exitCode=1});
