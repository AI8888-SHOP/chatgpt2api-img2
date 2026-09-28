"""
用户端画图 API
通过 API 密钥认证，验证通过后才扣次数
"""
import time
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field
from services.api_key_service import api_key_service
from services.usage_service import usage_service, UsageRecord
from services.image_service import generate_image_result, edit_image_result, ImageGenerationError

router = APIRouter(prefix="/v1", tags=["image"])

DEFAULT_MODEL = "gpt-4o"

class ImageGenerateRequest(BaseModel):
    prompt: str = Field(..., min_length=1, description="画图描述")
    model: str = Field(default=DEFAULT_MODEL, description="模型")
    n: int = Field(default=1, ge=1, le=4, description="生成数量")

class ImageEditRequest(BaseModel):
    prompt: str = Field(..., min_length=1, description="编辑描述")
    images: list[str] = Field(..., min_length=1, description="Base64 编码的图片列表")
    model: str = Field(default=DEFAULT_MODEL, description="模型")

def require_api_key(authorization: str | None) -> str:
    """验证 API 密钥并返回完整密钥"""
    if not authorization:
        raise HTTPException(status_code=401, detail={"error": "Authorization header required"})
    
    # 支持 Bearer 或直接 key.secret 格式
    if authorization.startswith("Bearer "):
        full_key = authorization[7:]
    else:
        full_key = authorization
    
    success, error, api_key = api_key_service.validate_and_use(full_key)
    
    if not success:
        raise HTTPException(status_code=401, detail={"error": error})
    
    return full_key


@router.post("/images/generations")
async def generate_image(
    body: ImageGenerateRequest,
    authorization: str | None = Header(default=None),
):
    """生成图片"""
    start_time = time.time()
    full_key = require_api_key(authorization)
    api_key = api_key_service.verify_key(full_key)
    
    try:
        result = await generate_image_result(
            access_token="",  # 用户端不需要 access_token
            prompt=body.prompt,
            model=body.model,
            n=body.n,
        )
        
        duration_ms = int((time.time() - start_time) * 1000)
        
        # 记录成功
        usage_service.log(UsageRecord.create(
            api_key=api_key.key,
            api_key_name=api_key.name,
            action="image_generate",
            prompt=body.prompt,
            model=body.model,
            status="success",
            duration_ms=duration_ms,
        ))
        
        return result
        
    except ImageGenerationError as e:
        duration_ms = int((time.time() - start_time) * 1000)
        
        # 记录失败（不扣次数，因为生成失败了）
        usage_service.log(UsageRecord.create(
            api_key=api_key.key,
            api_key_name=api_key.name,
            action="image_generate",
            prompt=body.prompt,
            model=body.model,
            status="failed",
            error=str(e),
            duration_ms=duration_ms,
        ))
        
        raise HTTPException(status_code=500, detail={"error": str(e)})
    except Exception as e:
        duration_ms = int((time.time() - start_time) * 1000)
        
        usage_service.log(UsageRecord.create(
            api_key=api_key.key,
            api_key_name=api_key.name,
            action="image_generate",
            prompt=body.prompt,
            model=body.model,
            status="failed",
            error=str(e),
            duration_ms=duration_ms,
        ))
        
        raise HTTPException(status_code=500, detail={"error": str(e)})


@router.post("/images/edits")
async def edit_image(
    body: ImageEditRequest,
    authorization: str | None = Header(default=None),
):
    """编辑图片"""
    start_time = time.time()
    full_key = require_api_key(authorization)
    api_key = api_key_service.verify_key(full_key)
    
    # 解析图片
    images = []
    for img_b64 in body.images:
        # 支持 data:image/png;base64,xxx 格式
        if "," in img_b64:
            img_b64 = img_b64.split(",", 1)[1]
        import base64
        try:
            img_data = base64.b64decode(img_b64)
            images.append((img_data, f"image_{len(images)}.png", "image/png"))
        except Exception:
            raise HTTPException(status_code=400, detail={"error": "Invalid base64 image"})
    
    try:
        result = await edit_image_result(
            access_token="",
            prompt=body.prompt,
            images=images,
            model=body.model,
        )
        
        duration_ms = int((time.time() - start_time) * 1000)
        
        usage_service.log(UsageRecord.create(
            api_key=api_key.key,
            api_key_name=api_key.name,
            action="image_edit",
            prompt=body.prompt,
            model=body.model,
            status="success",
            duration_ms=duration_ms,
        ))
        
        return result
        
    except ImageGenerationError as e:
        duration_ms = int((time.time() - start_time) * 1000)
        
        usage_service.log(UsageRecord.create(
            api_key=api_key.key,
            api_key_name=api_key.name,
            action="image_edit",
            prompt=body.prompt,
            model=body.model,
            status="failed",
            error=str(e),
            duration_ms=duration_ms,
        ))
        
        raise HTTPException(status_code=500, detail={"error": str(e)})


@router.get("/key/info")
async def get_key_info(
    authorization: str | None = Header(default=None),
):
    """获取密钥信息"""
    full_key = require_api_key(authorization)
    api_key = api_key_service.verify_key(full_key)
    
    return {
        "name": api_key.name,
        "total_usage": api_key.total_usage,
        "remaining": api_key.remaining(),
        "expires_at": api_key.expires_at,
        "created_at": api_key.created_at,
        "enabled": api_key.enabled,
    }
