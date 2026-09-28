from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid

from fastapi import HTTPException

from services.editable_studio_images import save_images
from services.editable_studio_models import DocumentPlan
from services.editable_studio_provider import StudioProvider, StudioProviderError
from services.editable_studio_store import StudioStore, failure
from services.editable_studio_templates import TEMPLATES


class StudioService:
    def __init__(self, config, users, root, provider_factory=StudioProvider):
        self.config, self.users, self.root = config, users, Path(root)
        self.store = StudioStore(users)
        self.provider_factory = provider_factory
        self.worker_id = uuid.uuid4().hex
        self.stop_event = threading.Event()
        self.thread = None
        self.last_prune = 0.0

    def settings(self):
        s = self.config.get_studio_settings()
        if not s.enabled:
            failure(503, "文档工作室尚未启用，请联系管理员")
        try:
            s.connection(self.config.get_prompt_optimizer_settings())
        except ValueError:
            failure(503, "文档工作室 API 尚未配置完整")
        return s

    def public_config(self):
        s = self.config.get_studio_settings()
        return {"enabled":s.enabled,"templates":TEMPLATES,"limits":{k:getattr(s,k) for k in ("max_pages","max_layers","max_image_mb","max_image_pixels","max_reference_images","plan_revisions","plan_user_rpm","plan_daily_requests","user_daily_jobs","user_queue_size","ppt_page_price","psd_task_price","retention_days")}}

    def _validate_plan(self, plan, images, s):
        if len(plan.slides)>s.max_pages or len(plan.layers)+1>s.max_layers:
            failure(422, "页面或图层数量超过管理员限制")
        if plan.kind=="psd" and len(images)!=1:
            failure(422, "PSD 需要一张原图")
        if plan.kind=="ppt" and any(x.image_index is not None and x.image_index>=len(images) for x in plan.slides):
            failure(422, "页面引用了不存在的图片")

    def _input_paths(self, images):
        base = (self.root/"inputs").resolve()
        paths = [(base/p).resolve() for p in images]
        if any(not p.is_relative_to(base) or not p.is_file() for p in paths):
            failure(410, "原始素材已过期，请重新上传")
        return paths

    def plan(self, user, request):
        s = self.settings()
        if (request.kind=="ppt" and request.page_count>s.max_pages) or (request.kind=="psd" and request.layer_count>s.max_layers):
            failure(422, "页面或图层数量超限")
        self.check_storage(s)
        plan_id = uuid.uuid4().hex
        prior = self.store.get_plan(user.id,request.previous_plan_id) if request.previous_plan_id else None
        if prior and json.loads(prior["payload"])["kind"]!=request.kind:
            failure(422, "不能更改同一草稿的任务类型")
        root_id = prior["root_id"] if prior else plan_id
        revision = prior["revision"]+1 if prior else 1
        previous_images = json.loads(prior["images"]) if prior and not request.base64_images else []
        count = len(request.base64_images) if request.base64_images else len(previous_images)
        budget = s.max_input_tokens+s.upstream_input_reserve+count*s.image_token_reserve+s.plan_output_tokens
        call_id = self.store.reserve_plan(user.id,root_id,budget,s)
        provider = None
        status = "failed"
        destination = self.root/"inputs"/plan_id
        try:
            provider = self.provider_factory(s,self.config.get_prompt_optimizer_settings())
            paths = self._input_paths(previous_images) if previous_images else save_images(request.base64_images,destination,s,request.kind)
            brief = request.model_dump(exclude={"base64_images","previous_plan_id"})
            brief["task"] = "整理为可供用户确认的制作方案。PPT 严格匹配 page_count，PSD layers 仅含前景，背景不占一个条目。"
            brief["image_count"] = len(paths)
            if prior:
                brief["previous_plan"] = json.loads(prior["payload"])
            result = provider.produce(brief,paths)
            if result.kind!=request.kind:
                failure(502, "AI 返回了错误的任务类型")
            result.template_id = request.template_id
            result.fill_background = request.fill_background
            self._validate_plan(result,paths,s)
            if result.kind=="ppt" and len(result.slides)!=request.page_count:
                failure(502, "AI 大纲页数不符合要求，请重新整理需求")
            if result.kind=="psd" and len(result.layers)+1>request.layer_count:
                failure(502, "AI 拆分图层数超过要求，请减少内容后重试")
            image_refs = [str(p.relative_to(self.root/"inputs")) for p in paths]
            self.store.save_plan(plan_id,user.id,root_id,revision,result.model_dump(),request.model_dump(exclude={"base64_images"}),image_refs)
            status = "success"
            return {"plan_id":plan_id,"plan":result.model_dump(),"price":self.price(result,s),"revision":revision,"expires_in":86400}
        except StudioProviderError as exc:
            failure(502,str(exc))
        finally:
            usage = provider.usage_tokens if provider and provider.usage_known else None
            self.store.finish_plan_call(call_id,status,usage)
            if status!="success" and destination.exists():
                shutil.rmtree(destination)

    @staticmethod
    def price(plan,s):
        return len(plan.slides)*s.ppt_page_price if plan.kind=="ppt" else s.psd_task_price

    def submit(self,user,body):
        fingerprint = hashlib.sha256((body.plan_id+body.plan.model_dump_json()).encode()).hexdigest()
        existing = self.store.find_submission(user.id,body.client_task_id)
        if existing:
            if existing["fingerprint"]!=fingerprint:
                failure(409,"此提交编号已用于不同的任务")
            return self.public_job(existing)
        s = self.settings()
        saved = self.store.get_plan(user.id,body.plan_id)
        if json.loads(saved["payload"])["kind"]!=body.plan.kind:
            failure(422,"任务类型与制作方案不符")
        images = self._input_paths(json.loads(saved["images"]))
        self._validate_plan(body.plan,images,s)
        price = self.price(body.plan,s)
        if body.expected_price!=price:
            failure(409,"积分价格或页数已变化，请重新确认")
        self.check_storage(s)
        budget = (s.max_retries+1)*(s.max_input_tokens+s.upstream_input_reserve+len(images)*s.image_token_reserve)+s.task_output_tokens
        row = self.store.admit_job(user.id,body,fingerprint,price,budget,s)
        return self.public_job(row)

    def public_job(self,row):
        item = {k:row[k] for k in ("id","kind","status","phase","price","error")}
        item.update({"created_at":datetime.fromtimestamp(row["created"],timezone.utc).isoformat(),"elapsed_seconds":max(0,int((row["updated"] if row["status"] in ("success","error") else time.time())-(row["started"] or row["created"]))),"title":json.loads(row["payload"])["title"]})
        if row["status"]=="success":
            result = json.loads(row["result"])
            prefix = f"/v1/editable-studio/jobs/{row['id']}/files/"
            item["result"] = {**result,"primary_url":prefix+result["primary"],"zip_url":prefix+result["zip"],"previews":[prefix+x for x in result["previews"]]}
            if result.get("original"):
                item["result"]["original_url"] = prefix+result["original"]
            item["expired"] = row["updated"]<time.time()-self.config.get_studio_settings().retention_days*86400
        return item

    def file_path(self,owner,job_id,filename):
        row = self.store.get_job(owner,job_id)
        if row["status"]!="success":
            failure(404,"文件尚未生成")
        if row["updated"]<time.time()-self.config.get_studio_settings().retention_days*86400:
            failure(410,"文件已超过保留期限")
        result = json.loads(row["result"])
        allowed = {result.get(k) for k in ("primary","zip","pdf","original")}|set(result.get("previews",[]))
        if filename not in allowed or Path(filename).name!=filename:
            failure(404,"文件不存在")
        base = (self.root/"outputs"/job_id).resolve()
        path = (base/filename).resolve()
        if not path.is_relative_to(base) or not path.is_file():
            failure(404,"文件不存在")
        return path

    def start(self):
        if self.thread and self.thread.is_alive():
            return
        self.stop_event.clear()
        self.thread = threading.Thread(target=self._schedule,name="editable-studio-queue",daemon=True)
        self.thread.start()

    def check_storage(self,s):
        self.root.mkdir(parents=True,exist_ok=True,mode=0o700)
        used = sum(p.stat().st_size for p in self.root.rglob("*") if p.is_file())
        # Conservative headroom per active worker, including native files, previews and inputs.
        reserve = s.global_concurrency*s.max_file_mb*3*1024*1024
        if used+reserve>s.max_storage_mb*1024*1024 or shutil.disk_usage(self.root).free<reserve+512*1024*1024:
            failure(503,"文件存储空间不足，请管理员清理或调整保留期限")

    def stop(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=2)

    def _schedule(self):
        while not self.stop_event.is_set():
            try:
                self.store.heartbeat(self.worker_id)
                self.store.reap()
                s = self.config.get_studio_settings()
                if s.enabled:
                    job = self.store.claim(self.worker_id,s)
                    if job:
                        threading.Thread(target=self.run_job,args=(job,),name="studio-"+job["id"][:8],daemon=True).start()
                if time.time()-self.last_prune>3600:
                    self.prune()
                    self.last_prune=time.time()
            except Exception as exc:
                # No request, path, identity, credentials or provider bodies in logs.
                print("[editable-studio] scheduler error:",type(exc).__name__)
            self.stop_event.wait(1)

    def prune(self):
        s = self.config.get_studio_settings()
        cutoff = time.time()-s.retention_days*86400
        with self.store.connect() as c:
            rows = c.execute("SELECT id FROM studio_jobs WHERE status IN ('success','error') AND updated<?",(cutoff,)).fetchall()
            # Keep plan inputs while any recent plan or active job can reference them.
            plans = c.execute("SELECT p.images FROM studio_plans p WHERE p.created>=? OR EXISTS (SELECT 1 FROM studio_jobs j WHERE j.plan_id=p.id AND (j.status IN ('queued','running') OR j.updated>=?))",(time.time()-86400,cutoff)).fetchall()
        retained = {Path(p).parts[0] for row in plans for p in json.loads(row[0])}
        for row in rows:
            path = self.root/"outputs"/row["id"]
            if path.is_dir():
                shutil.rmtree(path)
        inputs = self.root/"inputs"
        if inputs.exists():
            for path in inputs.iterdir():
                if path.is_dir() and path.name not in retained and path.stat().st_mtime<time.time()-86400:
                    shutil.rmtree(path)

    def run_job(self,job):
        provider = None
        result = None
        error = ""
        out = self.root/"outputs"/job["id"]
        try:
            s = self.settings()
            snapshot = json.loads(job.get("settings") or "{}")
            if snapshot:
                s = type(s).model_validate({**s.model_dump(),**snapshot})
            self.check_storage(s)
            saved = self.store.get_plan(job["user_id"],job["plan_id"])
            images = self._input_paths(json.loads(saved["images"]))
            confirmed = DocumentPlan.model_validate_json(job["payload"])
            provider = self.provider_factory(s,self.config.get_prompt_optimizer_settings())
            for attempt in range(s.max_retries+1):
                try:
                    result_plan = provider.produce({"task":"按用户已确认的方案完成内容细化。保持种类、标题、页面/图层数量和顺序。PPT 不增加未知事实；PSD 精确完善每个图层的轮廓。不要改变用户确认的需求。", "confirmed_plan":confirmed.model_dump(), "source_request":json.loads(saved["request"])["prompt"]},images,generation=True,deadline=job["deadline"])
                    if result_plan.kind!=confirmed.kind or len(result_plan.slides)!=len(confirmed.slides) or len(result_plan.layers)!=len(confirmed.layers):
                        raise StudioProviderError("AI 未遵守已确认的页面或图层数量")
                    break
                except StudioProviderError:
                    if attempt==s.max_retries or provider.output_tokens>=s.task_output_tokens or provider.usage_tokens>=job["budget"]:
                        raise
            result_plan.template_id = confirmed.template_id
            result_plan.fill_background = confirmed.fill_background
            result_plan.title = confirmed.title
            # User-reviewed headings/names are authoritative; do not silently rename them.
            for original,generated in zip(confirmed.slides,result_plan.slides):
                generated.title = original.title
            for original,generated in zip(confirmed.layers,result_plan.layers):
                generated.name,generated.kind = original.name,original.kind
                generated.box = original.box
            self._validate_plan(result_plan,images,s)
            if provider.usage_tokens>job["budget"]:
                raise StudioProviderError("上游实际用量超出预留预算，请管理员检查限额参数")
            self.store.phase(job["id"],"生成文件并核对预览")
            out.mkdir(parents=True,exist_ok=True,mode=0o700)
            request_path = out/"render-request.json"
            request_path.write_text(json.dumps({"plan":result_plan.model_dump(),"images":[str(p) for p in images],"out":str(out),"memory_mb":s.render_memory_mb},ensure_ascii=False),encoding="utf-8")
            env = {"PATH":os.environ.get("PATH","/usr/bin:/bin"),"LANG":"C.UTF-8","OMP_NUM_THREADS":"1","OPENBLAS_NUM_THREADS":"1","PYTHONPATH":str(Path(__file__).resolve().parents[1])}
            proc = subprocess.Popen([sys.executable,"-m","services.editable_studio_render","--request",str(request_path)],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
            try:
                proc.wait(timeout=max(1,min(300,job["deadline"]-time.time())))
            except BaseException:
                os.killpg(proc.pid,signal.SIGKILL)
                proc.wait()
                raise
            if proc.returncode:
                error_file = out/"render-error.json"
                message = json.loads(error_file.read_text())["error"] if error_file.is_file() else "文件生成失败或资源限额已用完"
                raise StudioProviderError(message)
            result = json.loads((out/"result.json").read_text())
            if any((out/result[k]).stat().st_size>s.max_file_mb*1024*1024 for k in ("primary","zip")):
                raise StudioProviderError("生成文件过大，已停止交付，请减少页面或图层")
            if time.time()>job["deadline"]:
                raise StudioProviderError("任务执行超时")
        except HTTPException as exc:
            error = str(exc.detail.get("error","任务失败")) if isinstance(exc.detail,dict) else "任务失败"
        except StudioProviderError as exc:
            error = str(exc)
        except Exception:
            error = "生成任务失败或超时，积分已退回，请稍后重试"
        usage = provider.usage_tokens if provider and provider.usage_known else None
        committed = self.store.finish(job["id"],result=result,error=error,usage=usage,output_tokens=provider.output_tokens if provider else 0)
        if (error or not committed) and out.exists():
            shutil.rmtree(out)
