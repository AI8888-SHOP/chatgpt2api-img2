"""
管理员后台 API
通过管理员密钥认证
"""
from datetime import datetime
from fastapi import APIRouter, HTTPException, Header, Query
from pydantic import BaseModel, Field
from services.admin_audit_service import admin_audit_service
from services.api_key_service import api_key_service
from services.generated_image_cache_service import generated_image_cache_service
from services.usage_service import usage_service
from services.account_service import account_service
from services.config import config
from services.user_service import user_service

router = APIRouter(prefix="/admin/api", tags=["admin"])

def parse_admin_authorization(authorization: str | None) -> tuple[str, str]:
    if not authorization:
        return "", ""
    full_key = authorization[7:] if authorization.startswith("Bearer ") else authorization
    identity, separator, key = str(full_key or "").partition("|")
    if separator:
        return key.strip(), identity.strip()[:80]
    return str(full_key or "").strip(), ""


def mask_admin_key(value: str) -> str:
    token = str(value or "").strip()
    if not token:
        return ""
    if len(token) <= 8:
        return f"{token[:2]}***"
    return f"{token[:6]}***{token[-4:]}"


def require_admin(authorization: str | None) -> str:
    """验证管理员密钥"""
    if not authorization:
        raise HTTPException(status_code=401, detail={"error": "Authorization header required"})
    full_key, identity = parse_admin_authorization(authorization)

    if full_key == str(config.auth_key or "").strip():
        return f"{identity or 'admin'} ({mask_admin_key(full_key)})"

    raise HTTPException(status_code=401, detail={"error": "Invalid admin key"})


@router.post("/auth/login")
async def admin_login(
    authorization: str | None = Header(default=None),
):
    """管理员登录校验"""
    require_admin(authorization)
    return {"ok": True}

# ── 兑换码管理 ─────────────────────────────────────────────

class CreateKeyRequest(BaseModel):
    name: str = Field(default="", description="兑换码名称")
    customer_name: str = Field(default="", description="客户名称")
    channel: str = Field(default="", description="渠道")
    package_name: str = Field(default="", description="套餐名称")
    batch_code: str = Field(default="", description="批次号")
    max_usage: int = Field(default=100, ge=0, description="兑换后赠送积分")
    expires_days: int = Field(default=0, ge=0, description="有效期天数，0 表示永不过期")
    is_admin: bool = Field(default=False, description="保留字段，普通生成均作为兑换码")


class DeleteGeneratedImagesRequest(BaseModel):
    ids: list[str] = Field(default_factory=list, description="图片缓存记录 ID 列表")


class AdminCreateUserRequest(BaseModel):
    email: str = ""
    password: str = ""
    quota: int = Field(default=0, ge=0)
    enabled: bool = True


class AdminUpdateUserRequest(BaseModel):
    email: str | None = None
    password: str | None = None
    quota: int | None = Field(default=None, ge=0)
    enabled: bool | None = None


class AdminAdjustQuotaRequest(BaseModel):
    amount: int = 0

@router.post("/keys")
async def create_key(
    body: CreateKeyRequest,
    authorization: str | None = Header(default=None),
):
    """创建新的积分兑换码"""
    admin_key = require_admin(authorization)
    
    full_key, api_key = api_key_service.generate_key(
        name=body.name,
        customer_name=body.customer_name,
        channel=body.channel,
        package_name=body.package_name,
        batch_code=body.batch_code,
        max_usage=body.max_usage,
        expires_days=body.expires_days,
        is_admin=False,
    )
    
    admin_audit_service.log(
        admin_key,
        "key.create",
        api_key.key,
        {"name": body.name, "credit_amount": api_key.redeem_amount(), "expires_days": body.expires_days},
    )
    return {
        "success": True,
        "key": full_key,  # 完整兑换码，仅返回这一次
        "api_key": api_key.to_dict(),
    }

@router.get("/keys")
async def list_keys(
    authorization: str | None = Header(default=None),
):
    """列出所有兑换码"""
    admin_key = require_admin(authorization)
    keys = api_key_service.list_keys()
    redeemed_codes = user_service.list_redeemed_codes([str(item.get("key") or "") for item in keys])
    
    # 格式化时间
    for k in keys:
        redeemed = redeemed_codes.get(str(k.get("key") or ""))
        if redeemed:
            k["redeemed_at"] = int(redeemed.get("redeemed_at") or 0)
            k["redeemed_by"] = str(redeemed.get("user_id") or "")
            k["redeemed_amount"] = int(redeemed.get("amount") or 0)
            k.pop("full_key", None)
            k["full_key_available"] = False
        if k.get("created_at"):
            k["created_at_str"] = datetime.fromtimestamp(k["created_at"]).strftime("%Y-%m-%d %H:%M:%S")
        if k.get("expires_at"):
            k["expires_at_str"] = datetime.fromtimestamp(k["expires_at"]).strftime("%Y-%m-%d %H:%M:%S") if k["expires_at"] > 0 else "永不过期"
        api_key = api_key_service.get_key(k["key"])
        k["is_valid"] = api_key.is_valid() if api_key else False
        if redeemed:
            k["is_valid"] = False
        k["remaining"] = 0 if k.get("redeemed_at") else 1
    
    return {"keys": keys}

@router.get("/keys/{key}")
async def get_key_info(
    key: str,
    authorization: str | None = Header(default=None),
):
    """获取兑换码详情"""
    require_admin(authorization)
    
    api_key = api_key_service.get_key(key)
    if not api_key:
        raise HTTPException(status_code=404, detail={"error": "Key not found"})
    
    d = api_key.to_dict()
    redeemed = user_service.get_redeemed_code(key)
    if redeemed:
        d["redeemed_at"] = int(redeemed.get("redeemed_at") or 0)
        d["redeemed_by"] = str(redeemed.get("user_id") or "")
        d["redeemed_amount"] = int(redeemed.get("amount") or 0)
        d.pop("full_key", None)
        d["full_key_available"] = False
    d["is_valid"] = api_key.is_valid()
    if redeemed:
        d["is_valid"] = False
    d["remaining"] = api_key.remaining()
    d["created_at_str"] = datetime.fromtimestamp(d["created_at"]).strftime("%Y-%m-%d %H:%M:%S")
    d["expires_at_str"] = datetime.fromtimestamp(d["expires_at"]).strftime("%Y-%m-%d %H:%M:%S") if d["expires_at"] > 0 else "永不过期"
    
    return {"api_key": d}

@router.put("/keys/{key}")
async def update_key(
    key: str,
    name: str | None = None,
    customer_name: str | None = None,
    channel: str | None = None,
    package_name: str | None = None,
    batch_code: str | None = None,
    enabled: bool | None = None,
    max_usage: int | None = None,
    expires_days: int | None = None,
    authorization: str | None = Header(default=None),
):
    """更新兑换码设置"""
    admin_key = require_admin(authorization)
    
    updates = {}
    if name is not None:
        updates["name"] = name
    if customer_name is not None:
        updates["customer_name"] = customer_name
    if channel is not None:
        updates["channel"] = channel
    if package_name is not None:
        updates["package_name"] = package_name
    if batch_code is not None:
        updates["batch_code"] = batch_code
    if enabled is not None:
        updates["enabled"] = enabled
    if max_usage is not None:
        updates["max_usage"] = max_usage
        updates["credit_amount"] = max(0, int(max_usage or 0))
    if expires_days is not None:
        now = int(datetime.now().timestamp())
        updates["expires_at"] = now + (expires_days * 86400) if expires_days > 0 else 0
    
    if not api_key_service.update_key(key, **updates):
        raise HTTPException(status_code=404, detail={"error": "Key not found"})
    
    api_key = api_key_service.get_key(key)
    admin_audit_service.log(admin_key, "key.update", key, updates)
    return {"success": True, "api_key": api_key.to_dict()}

@router.delete("/keys/{key}")
async def delete_key(
    key: str,
    authorization: str | None = Header(default=None),
):
    """删除兑换码"""
    admin_key = require_admin(authorization)
    
    if not api_key_service.delete_key(key):
        raise HTTPException(status_code=404, detail={"error": "Key not found"})
    admin_audit_service.log(admin_key, "key.delete", key)
    
    return {"success": True}

@router.post("/keys/{key}/reset")
async def reset_key_usage(
    key: str,
    authorization: str | None = Header(default=None),
):
    """重置兑换状态"""
    admin_key = require_admin(authorization)
    
    if not api_key_service.reset_usage(key):
        raise HTTPException(status_code=404, detail={"error": "Key not found"})
    user_service.reset_redeemed_code(key)
    admin_audit_service.log(admin_key, "key.reset", key)
    
    return {"success": True}

@router.post("/keys/{key}/add-usage")
async def add_key_usage(
    key: str,
    amount: int = Query(..., gt=0),
    authorization: str | None = Header(default=None),
):
    """增加兑换码可兑换积分"""
    admin_key = require_admin(authorization)
    
    api_key = api_key_service.get_key(key)
    if not api_key:
        raise HTTPException(status_code=404, detail={"error": "Key not found"})
    
    if api_key.redeemed_at:
        raise HTTPException(status_code=400, detail={"error": "Redeemed code cannot be topped up"})

    api_key_service.update_key(key, credit_amount=max(0, int(api_key.redeem_amount())) + amount)
    api_key = api_key_service.get_key(key)
    admin_audit_service.log(admin_key, "key.top_up", key, {"amount": amount})
    
    return {"success": True, "api_key": api_key.to_dict()}


# ── 用户管理 ─────────────────────────────────────────────

@router.get("/users")
async def list_users(
    query: str = Query(default=""),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    authorization: str | None = Header(default=None),
):
    admin_key = require_admin(authorization)
    return user_service.list_users(query=query, limit=limit, offset=offset)


@router.post("/users")
async def create_user(
    body: AdminCreateUserRequest,
    authorization: str | None = Header(default=None),
):
    admin_key = require_admin(authorization)
    try:
        user = user_service.create_user(body.email, body.password, quota=body.quota, enabled=body.enabled)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
    admin_audit_service.log(admin_key, "user.create", user.id, {"email": user.email, "quota": body.quota})
    return {"success": True, "user": user.to_public_dict()}


@router.get("/users/{user_id}")
async def get_user(
    user_id: str,
    authorization: str | None = Header(default=None),
):
    admin_key = require_admin(authorization)
    user = user_service.get_user(user_id)
    if not user:
        raise HTTPException(status_code=404, detail={"error": "User not found"})
    return {
        "user": user.to_public_dict(),
        "api_keys": user_service.list_api_keys(user.id),
        "quota_ledger": user_service.list_quota_ledger(user.id, limit=50, offset=0),
        "image_conversations": user_service.list_image_conversations(user.id, limit=10, offset=0),
    }


@router.put("/users/{user_id}")
async def update_user(
    user_id: str,
    body: AdminUpdateUserRequest,
    authorization: str | None = Header(default=None),
):
    admin_key = require_admin(authorization)
    try:
        user = user_service.update_user(
            user_id,
            email=body.email,
            password=body.password,
            quota=body.quota,
            enabled=body.enabled,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
    if not user:
        raise HTTPException(status_code=404, detail={"error": "User not found"})
    admin_audit_service.log(
        admin_key,
        "user.update",
        user_id,
        {key: value for key, value in body.model_dump().items() if value is not None and key != "password"},
    )
    return {"success": True, "user": user.to_public_dict()}


@router.delete("/users/{user_id}")
async def delete_user(
    user_id: str,
    authorization: str | None = Header(default=None),
):
    admin_key = require_admin(authorization)
    if not user_service.delete_user(user_id):
        raise HTTPException(status_code=404, detail={"error": "User not found"})
    admin_audit_service.log(admin_key, "user.delete", user_id)
    return {"success": True}


@router.post("/users/{user_id}/quota")
async def adjust_user_quota(
    user_id: str,
    body: AdminAdjustQuotaRequest,
    authorization: str | None = Header(default=None),
):
    admin_key = require_admin(authorization)
    user = user_service.add_quota(user_id, body.amount, reason="admin_adjust")
    if not user:
        raise HTTPException(status_code=404, detail={"error": "User not found"})
    admin_audit_service.log(admin_key, "user.quota", user_id, {"amount": body.amount})
    return {"success": True, "user": user.to_public_dict()}


@router.get("/users/{user_id}/api-keys")
async def list_user_api_keys(
    user_id: str,
    authorization: str | None = Header(default=None),
):
    require_admin(authorization)
    user = user_service.get_user(user_id)
    if not user:
        raise HTTPException(status_code=404, detail={"error": "User not found"})
    return {"api_keys": user_service.list_api_keys(user_id)}


@router.delete("/users/{user_id}/api-keys/{key}")
async def delete_user_api_key(
    user_id: str,
    key: str,
    authorization: str | None = Header(default=None),
):
    admin_key = require_admin(authorization)
    if not user_service.delete_api_key(user_id, key):
        raise HTTPException(status_code=404, detail={"error": "API key not found"})
    admin_audit_service.log(admin_key, "user.api_key.delete", user_id, {"key": key})
    return {"success": True}


@router.delete("/users/{user_id}/image-conversations")
async def clear_user_image_conversations(
    user_id: str,
    authorization: str | None = Header(default=None),
):
    admin_key = require_admin(authorization)
    user = user_service.get_user(user_id)
    if not user:
        raise HTTPException(status_code=404, detail={"error": "User not found"})
    deleted = user_service.clear_image_conversations(user_id)
    admin_audit_service.log(admin_key, "user.image_history.clear", user_id, {"deleted": deleted})
    return {"success": True, "deleted": deleted}


@router.delete("/users/{user_id}/image-conversations/{conversation_id}")
async def delete_user_image_conversation(
    user_id: str,
    conversation_id: str,
    authorization: str | None = Header(default=None),
):
    admin_key = require_admin(authorization)
    user = user_service.get_user(user_id)
    if not user:
        raise HTTPException(status_code=404, detail={"error": "User not found"})
    deleted = user_service.delete_image_conversation(user_id, conversation_id)
    admin_audit_service.log(admin_key, "user.image_history.delete", user_id, {"conversation_id": conversation_id, "deleted": deleted})
    return {"success": True, "deleted": deleted}

# ── 用量统计 ─────────────────────────────────────────────

@router.get("/usage/stats")
async def get_usage_stats(
    api_key: str | None = None,
    days: int = Query(default=7, ge=1, le=90),
    authorization: str | None = Header(default=None),
):
    """获取用量统计"""
    require_admin(authorization)
    
    stats = usage_service.get_stats(api_key=api_key, days=days)
    return stats

@router.get("/usage/records")
async def get_usage_records(
    api_key: str | None = None,
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    authorization: str | None = Header(default=None),
):
    """获取用量记录"""
    require_admin(authorization)
    
    records = usage_service.get_records(api_key=api_key, limit=limit, offset=offset)
    
    # 格式化时间
    for r in records.get("records", []):
        if r.get("timestamp"):
            r["timestamp_str"] = datetime.fromtimestamp(r["timestamp"]).strftime("%Y-%m-%d %H:%M:%S")
    
    return records

@router.delete("/usage/records")
async def clear_usage_records(
    days: int = Query(default=30, ge=1),
    authorization: str | None = Header(default=None),
):
    """清理旧的使用记录"""
    admin_key = require_admin(authorization)
    
    usage_service.clear_old_records(days=days)
    admin_audit_service.log(admin_key, "usage.clear", "", {"days": days})
    return {"success": True, "message": f"已清理 {days} 天前的记录"}


@router.get("/generated-images")
async def list_generated_images(
    query: str = Query(default=""),
    action: str = Query(default="all"),
    limit: int = Query(default=60, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    authorization: str | None = Header(default=None),
):
    require_admin(authorization)
    result = generated_image_cache_service.list_images(
        query=query,
        action=action,
        limit=limit,
        offset=offset,
    )
    return result


@router.delete("/generated-images")
async def delete_generated_images(
    body: DeleteGeneratedImagesRequest,
    authorization: str | None = Header(default=None),
):
    admin_key = require_admin(authorization)
    result = generated_image_cache_service.delete_images(body.ids)
    admin_audit_service.log(admin_key, "image_cache.delete", "", {"requested": len(body.ids), "deleted": result.get("deleted", 0)})
    return {
        "success": True,
        **result,
    }


@router.get("/audit")
async def list_audit_records(
    action: str = Query(default=""),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    authorization: str | None = Header(default=None),
):
    require_admin(authorization)
    return admin_audit_service.list_records(action=action, limit=limit, offset=offset)

# ── 账号管理 ─────────────────────────────────────────────

@router.get("/accounts")
async def list_accounts(
    authorization: str | None = Header(default=None),
):
    """列出所有账号"""
    require_admin(authorization)
    
    accounts = account_service.list_accounts()
    return {"accounts": accounts}

@router.get("/accounts/stats")
async def get_accounts_stats(
    authorization: str | None = Header(default=None),
):
    """获取账号统计"""
    require_admin(authorization)
    
    accounts = account_service.list_accounts()
    
    def has_status(account: dict, *values: str) -> bool:
        return str(account.get("status") or "").strip() in values

    total = len(accounts)
    active = len([a for a in accounts if has_status(a, "active", "正常")])
    limited = len([a for a in accounts if has_status(a, "limited", "限流")])
    error = len([a for a in accounts if has_status(a, "error", "异常")])
    disabled = len([a for a in accounts if has_status(a, "disabled", "禁用")])
    
    return {
        "total": total,
        "active": active,
        "limited": limited,
        "error": error,
        "disabled": disabled,
    }

# ── 系统信息 ─────────────────────────────────────────────

@router.get("/system")
async def get_system_info(
    authorization: str | None = Header(default=None),
):
    """获取系统信息"""
    require_admin(authorization)
    
    keys = api_key_service.list_keys()
    
    return {
        "version": "1.0.0-commercial",
        "keys_total": len(keys),
        "keys_enabled": len([k for k in keys if k.get("enabled")]),
        "admin_keys": len([k for k in keys if k.get("is_admin")]),
    }
