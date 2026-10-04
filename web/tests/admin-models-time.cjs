// Intercept all application APIs: no production settings, users or paid calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const base = process.env.BASE_URL || 'http://127.0.0.1:3031';
const out = process.env.UI_ARTIFACTS || '/tmp/admin-models-time';

(async () => {
  fs.mkdirSync(out,{recursive:true});
  const browser = await chromium.launch({args:['--no-sandbox']});
  let count = 0;
  const check = (value, message) => {assert.ok(value,message);count++;};
  try {
    for (const zone of ['UTC','America/Los_Angeles']) {
      const context = await browser.newContext({timezoneId:zone,viewport:{width:1366,height:900}});
      let settings = JSON.parse(fs.readFileSync(path.join(__dirname,'../../config.example.json'),'utf8'));
      let failConfig = false;
      const submissions = [], errors = [];
      const timestamp = Date.parse('2026-10-04T16:00:00Z')/1000;
      await context.route('**/*',async route => {
        const req=route.request(),url=new URL(req.url()),p=url.pathname;
        const api=p==='/app-config'||['/v1/','/api/','/admin/api/','/auth/'].some(prefix=>p.startsWith(prefix));
        if (!api) return url.origin===new URL(base).origin||url.protocol==='data:'?route.continue():route.abort();
        let body={};
        if(p==='/app-config') {
          if(failConfig)return route.fulfill({status:503,json:{error:'synthetic failure'}});
          body={site_title:'测试工作台',image_models:settings.image_models.filter(i=>i.enabled),default_image_model:settings.default_image_model,quick_prompts:[]};
        } else if(p==='/api/settings') {
          if(req.method()==='POST')settings=req.postDataJSON();
          body={config:settings};
        } else if(p==='/v1/key/info')body={remaining:100};
        else if(p==='/v1/user/ui-trial')body={trial_id:'test',assigned_variant:'a',variant:'a',seen_a:true,seen_b:false,preference:null};
        else if(p==='/v1/image-conversations')body=req.method()==='GET'?{items:[]}:{success:true};
        else if(p==='/v1/image-jobs/generations') {
          submissions.push(req.postDataJSON());
          return route.fulfill({status:503,json:{error:'Synthetic test: no paid generation'}});
        } else if(p==='/api/cpa/pools')body={pools:[]};
        else if(p==='/api/sub2api/servers')body={servers:[]};
        else if(p==='/api/editable-studio/stats')body={daily_tokens:0,jobs:[],recent:[]};
        else if(p==='/admin/api/usage/records')body={records:[{id:'test',timestamp,timestamp_str:'2026-10-04 16:00:00',status:'success',action:'image_generate',model:'synthetic',prompt:'test',api_key_name:'test',duration_ms:1}],total:1};
        else if(p==='/admin/api/usage/stats')body={total:1,success:1,failed:0,avg_duration_ms:1,daily_stats:{},action_stats:{}};
        else if(p==='/admin/api/keys')body={keys:[{key:'synthetic',name:'测试兑换码',credit_amount:10,enabled:true,is_valid:false,created_at:timestamp,expires_at:timestamp+86400,redeemed_at:timestamp,created_at_str:'2026-10-04 16:00:00',expires_at_str:'2026-10-05 16:00:00'}]};
        else if(p.includes('image-jobs'))body={items:[]};
        return route.fulfill({json:body});
      });
      const page = await context.newPage();
      page.setDefaultTimeout(12000);
      page.on('pageerror',e=>errors.push(e.message));
      await page.goto(base+'/admin/settings/');
      const card=page.getByTestId('image-models-card');
      await card.getByRole('button',{name:'添加模型',exact:true}).click();
      await card.getByLabel('模型 ID 3',{exact:true}).fill('custom-image');
      await card.getByLabel('显示名称 3',{exact:true}).fill('自定义图像');
      await card.getByLabel('设为默认模型 3',{exact:true}).check();
      await card.getByRole('button',{name:'上移模型 3',exact:true}).click();
      await card.getByRole('button',{name:'保存模型',exact:true}).click();
      await page.getByText('配置已保存',{exact:true}).waitFor();
      check(settings.default_image_model==='custom-image' && settings.image_models[1].id==='custom-image','admin saves order and default');
      await card.screenshot({path:path.join(out,'models-'+zone.replaceAll('/','-')+'.png')});
      const imagePage=await context.newPage();
      imagePage.on('pageerror',e=>errors.push(e.message));
      await imagePage.goto(base+'/image/');
      await imagePage.getByRole('combobox',{name:'生图模型'}).getByText('自定义图像',{exact:true}).waitFor();
      await imagePage.getByLabel('图像提示词').fill('synthetic custom model');
      await imagePage.getByRole('button',{name:'开始生成',exact:true}).click();
      await imagePage.waitForFunction(()=>document.body.innerText.includes('Synthetic test'));
      check(submissions.length===1 && submissions[0].model==='custom-image','custom ID reaches generation');
      await card.getByTestId('image-model-row').nth(1).getByRole('checkbox').uncheck();
      const disabledSave=page.waitForResponse(r=>r.url().endsWith('/api/settings') && r.request().method()==='POST');
      await card.getByRole('button',{name:'保存模型',exact:true}).click();
      await disabledSave;
      await imagePage.evaluate(()=>window.dispatchEvent(new Event('focus')));
      await imagePage.getByRole('combobox',{name:'生图模型'}).getByText('gpt-image-2',{exact:true}).waitFor();
      await imagePage.getByRole('combobox',{name:'生图模型'}).click();
      check(await imagePage.getByRole('option',{name:'自定义图像',exact:true}).count()===0,'disabled model removed after focus refresh');
      await imagePage.keyboard.press('Escape');
      await card.getByTestId('image-model-row').nth(0).getByRole('checkbox').uncheck();
      await card.getByTestId('image-model-row').nth(2).getByRole('checkbox').uncheck();
      const saved=page.waitForResponse(r=>r.url().endsWith('/api/settings') && r.request().method()==='POST');
      await card.getByRole('button',{name:'保存模型',exact:true}).click();
      await saved;
      await imagePage.evaluate(()=>window.dispatchEvent(new Event('focus')));
      await imagePage.getByText('暂无可用模型，请联系管理员开放模型',{exact:true}).waitFor();
      check(await imagePage.getByRole('button',{name:'开始生成',exact:true}).isDisabled(),'empty list blocks generation');
      failConfig=true;
      await imagePage.evaluate(()=>window.dispatchEvent(new Event('focus')));
      await imagePage.getByText('模型配置加载失败，请刷新重试',{exact:true}).waitFor();
      check(await imagePage.getByRole('button',{name:'开始生成',exact:true}).isDisabled(),'failed config blocks generation');
      failConfig=false;
      await page.goto(base+'/admin/usage/');
      await page.getByRole('cell',{name:'2026-10-05 00:00:00',exact:true}).waitFor();
      check(await page.getByText('后台时间：北京时间 UTC+8',{exact:true}).isVisible(),'admin UTC8 visible in '+zone);
      await page.goto(base+'/admin/keys/');
      await page.getByText('2026-10-06 00:00:00',{exact:true}).waitFor();
      const downloadPromise=page.waitForEvent('download');
      await page.getByRole('button',{name:'导出 CSV',exact:true}).click();
      const download=await downloadPromise;
      const csv=fs.readFileSync(await download.path(),'utf8');
      check(csv.includes('redeemed_at (UTC+8)') && csv.includes('2026-10-05 00:00:00') && csv.includes('2026-10-06 00:00:00'),'CSV uses UTC8 including redemption');
      check(errors.length===0,errors.join('\n'));
      await context.close();
    }
    console.log(`${count} admin model/time browser checks passed`);
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
