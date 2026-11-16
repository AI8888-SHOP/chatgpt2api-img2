// Synthetic APIs and files only: never submits a paid upstream request.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const base = process.env.BASE_URL || 'http://127.0.0.1:3031';
const out = process.env.UI_ARTIFACTS || '/tmp/video-ui';
const grok = {id:'grok-imagine-video-1.5',label:'Grok 视频 1.5',protocol:'grok',enabled:true,max_reference_images:14,supports_voice:true,supports_audio_upload:false,min_duration:1,max_duration:15,reference_max_duration:15,resolutions:['480p','720p']};
const ark = {...grok,id:'seedance-video',label:'Seedance 视频',protocol:'seedance',supports_voice:false,supports_audio_upload:true,max_reference_images:9,min_duration:4};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY9sAAAAASUVORK5CYII=','base64');
const audio = Buffer.alloc(44+48000);
audio.write('RIFF');audio.writeUInt32LE(audio.length-8,4);audio.write('WAVEfmt ',8);audio.writeUInt32LE(16,16);audio.writeUInt16LE(1,20);audio.writeUInt16LE(1,22);audio.writeUInt32LE(8000,24);audio.writeUInt32LE(16000,28);audio.writeUInt16LE(2,32);audio.writeUInt16LE(16,34);audio.write('data',36);audio.writeUInt32LE(48000,40);

(async()=>{
  fs.mkdirSync(out,{recursive:true});
  const browser=await chromium.launch({args:['--no-sandbox']});
  let checks=0;
  const check=(value,label)=>{assert.ok(value,label);checks++;};
  try {
    for (const [variant,width] of [['a',1366],['b',1366],['a',390],['b',390]]) {
      const context=await browser.newContext({viewport:{width,height:900}});
      let settings={...JSON.parse(fs.readFileSync('/repo/config.example.json','utf8')),video_enabled:true,video_models:[grok,ark],default_video_model:grok.id,video_credits_per_second:2,video_public_base_url:'https://public.example',video_upstreams:[{name:'视频渠道',base_url:'https://provider.example',api_key:'synthetic-secret',enabled:true,models:[grok.id,ark.id]}]};
      let jobs=[],submissions=[],uploads=[],publicFailure=false,presets=[];
      const errors=[];
      await context.route('**/*',async route=>{
        const req=route.request(),url=new URL(req.url()),p=url.pathname;
        const api=p==='/app-config'||['/v1/','/api/','/admin/api/','/auth/'].some(prefix=>p.startsWith(prefix));
        if(!api)return url.origin===new URL(base).origin||url.protocol==='data:'?route.continue():route.abort();
        let body={};
        if(p==='/app-config'){
          if(publicFailure)return route.fulfill({status:503,json:{detail:'模型配置暂不可用'}});
          body={site_title:'创作工作台',image_models:settings.image_models,default_image_model:settings.default_image_model,video_enabled:settings.video_enabled,video_models:settings.video_models,default_video_model:settings.default_video_model,video_credits_per_second:2,quick_prompts:[]};
        }else if(p.startsWith('/v1/user/prompt-presets')){
          const id=p.split('/')[4];
          if(req.method()==='POST'){body={...req.postDataJSON(),id:'preset-1'};presets.push(body);}
          else if(req.method()==='PUT'){body={...req.postDataJSON(),id};presets=presets.map(item=>item.id===id?body:item);}
          else if(req.method()==='DELETE'){presets=presets.filter(item=>item.id!==id);body={ok:true};}
          else body={items:presets,limit:15};
        }else if(p==='/api/settings'){
          if(req.method()==='POST')settings=req.postDataJSON();
          body={config:settings};
        }else if(p==='/v1/key/info')body={remaining:1000};
        else if(p==='/v1/user/ui-trial')body={trial_id:'video',assigned_variant:variant,variant,seen_a:true,seen_b:true,preference:null};
        else if(p==='/v1/video-jobs')body={items:jobs};
        else if(p==='/v1/video-assets'){
          const raw=req.postDataBuffer().toString('utf8');
          const kind=raw.includes('name="kind"\r\n\r\naudio')?'audio':'image';uploads.push(kind);
          body={asset_id:(kind==='audio'?'b':'a').repeat(32),kind,size:100};
        }else if(p==='/v1/videos/generations'){
          const payload=req.postDataJSON();submissions.push(payload);
          body={...payload,request_id:'vid_'+submissions.length,status:'pending',created_at:Date.now()/1000,credits:10,accounted:false};jobs=[body,...jobs];
        }else if(p==='/v1/image-conversations'||p.includes('image-jobs'))body={items:[]};
        else if(p==='/api/cpa/pools')body={pools:[]};
        else if(p==='/api/sub2api/servers')body={servers:[]};
        else if(p==='/api/editable-studio/stats')body={daily_tokens:0,jobs:[],recent:[]};
        return route.fulfill({json:body});
      });
      const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
      const open=async()=>{await page.goto(base+'/image/');await page.getByRole('navigation',{name:'创作类型'}).getByRole('button',{name:'生成视频',exact:true}).click();await page.getByLabel('视频模型',{exact:true}).selectOption(grok.id);};
      await open();
      const workspace=page.getByRole('region',{name:'视频创作工作台'});
      check(await workspace.getByRole('button',{name:'编辑视频',exact:true}).count()===0,'disabled model hides editing');
      const native={...ark,id:'native-video',label:'原生视频',protocol:'native',supports_video_reference:true,supports_edit:true,supports_extend:true,resolutions:['720p','1080p']};
      settings.video_models.push(native);
      await open();await page.getByLabel('视频模型',{exact:true}).selectOption(native.id);
      await workspace.getByRole('button',{name:'编辑视频',exact:true}).click();
      check(await page.getByLabel('上传参考视频').isVisible(),'editing shows video upload');
      check(await page.getByLabel('视频比例',{exact:true}).isDisabled(),'editing disables ratio');
      await page.getByLabel('视频清晰度',{exact:true}).selectOption('1080p');
      await workspace.getByRole('button',{name:'延长视频',exact:true}).click();
      check(await page.getByLabel('上传参考视频').isVisible(),'extension shows video upload');
      await page.getByLabel('视频模型',{exact:true}).selectOption(grok.id);
      check(await page.getByLabel('上传参考视频').count()===0,'switching model clears unsupported controls');
      settings.video_models=settings.video_models.filter(m=>m.id!==native.id);
      const personal=workspace.getByTestId('personal-prompts');
      await personal.locator('summary').click();
      await personal.getByRole('button',{name:'新建预设',exact:true}).click();
      await personal.getByLabel('个人预设名称').fill('电影风格');
      await personal.getByLabel('个人预设内容').fill('自然光线，电影质感');
      await personal.getByRole('button',{name:'保存个人预设',exact:true}).click();
      await personal.getByRole('button',{name:'电影风格',exact:true}).click();
      check((await page.getByLabel('视频提示词',{exact:true}).inputValue()).includes('电影质感'),'personal preset applies');
      await open();await personal.locator('summary').click();
      await personal.getByRole('button',{name:'电影风格',exact:true}).waitFor();
      check(presets.length===1,'personal preset restored from server after reload');
      await personal.getByRole('button',{name:'编辑预设 电影风格',exact:true}).click();
      await personal.getByLabel('个人预设名称').fill('电影风格更新');
      await personal.getByRole('button',{name:'保存个人预设',exact:true}).click();
      await personal.getByRole('button',{name:'删除预设 电影风格更新',exact:true}).click();
      await personal.getByRole('button',{name:'确认删除预设',exact:true}).click();
      await personal.getByText('还没有个人预设，保存常用的风格或要求，下次一键填入。').waitFor();
      check(presets.length===0,'personal preset edit and delete');
      await page.getByLabel('视频提示词',{exact:true}).fill('海边日出，镜头向前推进');
      await workspace.getByRole('button',{name:'生成视频',exact:true}).click();
      await page.getByText('任务在后台运行，刷新或关闭页面不会中断',{exact:true}).waitFor();
      check(submissions.length===1&&submissions[0].mode==='text'&&submissions[0].reference_images.length===0,'text generation payload');
      check(Boolean(submissions[0].client_request_id),'submit has stable request ID');
      await workspace.screenshot({path:`${out}/pending-${variant}-${width}.png`});
      jobs=[{...jobs[0],status:'done',accounted:true,video:{url:'https://cdn.example/video.mp4'}}];
      await open();await workspace.locator('video').waitFor();
      check(await workspace.locator('video').getAttribute('src')==='https://cdn.example/video.mp4','history restores completed video after reload');
      jobs=[];await open();
      await workspace.getByRole('button',{name:'参考素材',exact:true}).click();
      await page.getByLabel('视频提示词',{exact:true}).fill('人物使用 <AUDIO_0> 说话');
      await page.getByLabel('上传视频参考图').setInputFiles({name:'reference.png',mimeType:'image/png',buffer:png});
      await page.getByLabel('参考音色',{exact:true}).fill('eve');
      check(await page.getByLabel('上传视频参考音频').count()===0,'Grok does not offer unsupported audio upload');
      await workspace.getByRole('button',{name:'生成视频',exact:true}).click();
      await page.getByText('任务在后台运行，刷新或关闭页面不会中断',{exact:true}).waitFor();
      check(submissions.at(-1).reference_images[0].asset_id==='a'.repeat(32)&&submissions.at(-1).reference_audios[0].voice_id==='eve','reference image and voice are submitted');
      jobs=[];await open();
      await page.getByLabel('视频模型',{exact:true}).selectOption(ark.id);
      await workspace.getByRole('button',{name:'参考素材',exact:true}).click();
      await page.getByLabel('视频提示词',{exact:true}).fill('根据参考图与音频制作产品视频');
      await page.getByLabel('上传视频参考图').setInputFiles({name:'reference.png',mimeType:'image/png',buffer:png});
      await page.getByLabel('上传视频参考音频').setInputFiles({name:'voice.wav',mimeType:'audio/wav',buffer:audio});
      await workspace.screenshot({path:`${out}/references-${variant}-${width}.png`});
      check(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'no horizontal overflow');
      await workspace.getByRole('button',{name:'生成视频',exact:true}).click();
      await page.getByText('任务在后台运行，刷新或关闭页面不会中断',{exact:true}).waitFor();
      check(submissions.at(-1).model===ark.id&&submissions.at(-1).reference_audios[0].asset_id==='b'.repeat(32)&&uploads.includes('audio'),'audio upload and Ark submission');
      await page.getByRole('navigation',{name:'创作类型'}).getByRole('button',{name:'生成图片',exact:true}).click();
      check(await page.getByLabel('图像提示词').isVisible(),'image composer remains available');
      publicFailure=true;await page.reload();await page.getByRole('navigation',{name:'创作类型'}).getByRole('button',{name:'生成视频',exact:true}).click();
      await workspace.getByText('模型配置暂不可用',{exact:false}).waitFor();
      check(await workspace.getByRole('button',{name:'生成视频',exact:true}).isDisabled(),'config failure blocks submission');
      publicFailure=false;
      await page.goto(base+'/admin/settings/');
      const card=page.getByTestId('video-settings-card');
      await card.getByRole('button',{name:'添加视频渠道',exact:true}).click();
      await page.getByLabel('视频渠道名称 2',{exact:true}).fill('新视频渠道');
      await page.getByLabel('视频渠道地址 2',{exact:true}).fill('https://new-provider.example/v1');
      await page.getByLabel('视频渠道密钥 2',{exact:true}).fill('synthetic-new');
      const models=page.getByLabel('视频渠道模型 2',{exact:true});
      await models.pressSequentially('grok-imagine-video-1.5,seedance-video');
      check(await models.inputValue()==='grok-imagine-video-1.5,seedance-video','multi-model separators survive typing');
      await page.getByLabel('视频每秒积分',{exact:true}).fill('3');
      await card.getByRole('button',{name:'保存视频设置',exact:true}).click();
      await page.getByText('配置已保存',{exact:true}).waitFor();
      check(settings.video_upstreams.length===2&&settings.video_credits_per_second===3&&settings.video_models.length===2,'admin saves independent video channels, models and price');
      check(settings.image_upstreams[0].name==='example','video settings preserve image channels');
      await card.screenshot({path:`${out}/settings-${variant}-${width}.png`});
      check(errors.length===0,errors.join('\n'));
      await context.close();
    }
    console.log(`Video browser checks passed: ${checks}`);
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
