"""
API 密钥管理服务
支持创建密钥、验证密钥、扣减次数、设置有效期
"""
import hashlib
import json
import os
import secrets
import time
from dataclasses import dataclass, asdict
from pathlib import Path
from threading import RLock
from typing import Optional

KEY_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"  # 避免混淆字符
DATA_FILE = Path(__file__).resolve().parent.parent / "data" / "api_keys.json"

@dataclass
class ApiKey:
    key: str
    name: str  # 密钥名称/备注
    secret_hash: str  # 密钥的 SHA256 哈希，用于验证
    secret_value: str = ""  # 普通兑换码的明文 secret，用于后台再次复制完整兑换码
    customer_name: str = ""  # 客户名称
    channel: str = ""  # 渠道标识
    package_name: str = ""  # 套餐名称
    batch_code: str = ""  # 批次号
    total_usage: int = 0  # 累计使用次数
    max_usage: int = -1  # 最大使用次数，-1 表示无限
    credit_amount: int = 0  # 兑换后赠送积分
    redeemed_by: str = ""  # 兑换用户 ID
    redeemed_at: int = 0  # 兑换时间戳
    created_at: int = 0  # 创建时间戳
    expires_at: int = 0  # 过期时间戳，0 表示永不过期
    enabled: bool = True
    is_admin: bool = False  # 是否为管理员密钥

    def is_valid(self) -> bool:
        """检查密钥是否有效"""
        if not self.enabled:
            return False
        
        now = int(time.time())
        # 检查过期时间
        if self.expires_at > 0 and now > self.expires_at:
            return False
        
        # 普通密钥现在作为兑换码使用，只能兑换一次。
        if not self.is_admin and self.redeemed_at > 0:
            return False

        # 管理员密钥保留旧的次数限制能力。
        if self.is_admin and self.max_usage > 0 and self.total_usage >= self.max_usage:
            return False
        
        return True

    def remaining(self) -> int:
        """剩余使用次数，-1 表示无限"""
        if self.max_usage <= 0:
            return -1
        return max(0, self.max_usage - self.total_usage)

    def redeem_amount(self) -> int:
        if self.credit_amount > 0:
            return self.credit_amount
        if not self.is_admin and self.max_usage > 0:
            return self.max_usage
        return 0

    def to_dict(self, include_secret: bool = False) -> dict:
        """转换为字典"""
        d = asdict(self)
        if not include_secret:
            d.pop("secret_hash", None)
            d.pop("secret_value", None)
        if not self.is_admin and self.secret_value and not self.redeemed_at:
            d["full_key"] = f"{self.key}.{self.secret_value}"
            d["full_key_available"] = True
        else:
            d["full_key_available"] = False
        return d


class ApiKeyService:
    def __init__(self):
        self._keys: dict[str, ApiKey] = {}
        self._secret_index: dict[str, str] = {}  # secret_hash -> key
        self._lock = RLock()
        self._load()

    def _load(self):
        """从文件加载密钥数据"""
        if not DATA_FILE.exists():
            DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
            return
        
        try:
            with open(DATA_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            
            for key, values in data.items():
                allowed = set(ApiKey.__dataclass_fields__.keys())
                clean_values = {key: value for key, value in dict(values).items() if key in allowed}
                api_key = ApiKey(**clean_values)
                if not api_key.is_admin and api_key.credit_amount <= 0 and api_key.max_usage > 0:
                    api_key.credit_amount = api_key.max_usage
                self._keys[key] = api_key
                if api_key.secret_hash:
                    self._secret_index[api_key.secret_hash] = key
                    
        except Exception as e:
            print(f"[api_key_service] failed to load keys: {e}")

    def _save(self):
        """保存密钥数据到文件"""
        DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
        data = {key: asdict(api_key) for key, api_key in self._keys.items()}
        tmp_file = DATA_FILE.with_suffix(f"{DATA_FILE.suffix}.tmp")
        with open(tmp_file, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp_file, DATA_FILE)

    def generate_key(
        self,
        name: str = "",
        max_usage: int = -1,
        expires_days: int = 0,
        is_admin: bool = False,
        customer_name: str = "",
        channel: str = "",
        package_name: str = "",
        batch_code: str = "",
    ) -> tuple[str, ApiKey]:
        """
        生成新的 API 密钥
        返回: (完整密钥字符串, ApiKey对象)
        """
        # 生成随机密钥
        raw_key = "".join(secrets.choice(KEY_CHARS) for _ in range(32))
        # 生成 secret 用于验证
        secret = "".join(secrets.choice(KEY_CHARS) for _ in range(48))
        
        secret_hash = hashlib.sha256(secret.encode()).hexdigest()
        
        now = int(time.time())
        expires_at = now + (expires_days * 86400) if expires_days > 0 else 0
        
        credit_amount = 0 if is_admin else max(0, int(max_usage or 0))

        api_key = ApiKey(
            key=raw_key,
            name=name,
            customer_name=customer_name,
            channel=channel,
            package_name=package_name,
            batch_code=batch_code,
            secret_hash=secret_hash,
            secret_value="" if is_admin else secret,
            max_usage=max_usage,
            credit_amount=credit_amount,
            created_at=now,
            expires_at=expires_at,
            is_admin=is_admin,
        )
        
        with self._lock:
            self._keys[raw_key] = api_key
            self._secret_index[secret_hash] = raw_key
            self._save()
        
        # 返回完整密钥 = key + secret
        full_key = f"{raw_key}.{secret}"
        return full_key, api_key

    def verify_key(self, full_key: str) -> Optional[ApiKey]:
        """
        验证密钥并返回 ApiKey 对象
        格式: key.secret
        """
        parts = full_key.strip().split(".")
        if len(parts) != 2:
            return None
        
        key_part, secret_part = parts
        api_key = self._keys.get(key_part)
        
        if not api_key:
            return None
        
        # 验证 secret
        secret_hash = hashlib.sha256(secret_part.encode()).hexdigest()
        if secret_hash != api_key.secret_hash:
            return None
        
        return api_key

    def validate_key(self, full_key: str) -> tuple[bool, str, Optional[ApiKey]]:
        """
        验证密钥但不扣减使用次数
        返回: (是否成功, 错误信息, ApiKey对象)
        """
        api_key = self.verify_key(full_key)

        if not api_key:
            return False, "Invalid API key", None

        if not api_key.is_valid():
            if not api_key.enabled:
                return False, "API key is disabled", None
            if api_key.expires_at > 0 and int(time.time()) > api_key.expires_at:
                return False, "API key has expired", None
            if api_key.max_usage > 0 and api_key.total_usage >= api_key.max_usage:
                return False, "API key usage limit reached", None

        return True, "", api_key

    def redeem(self, full_key: str, user_id: str) -> tuple[bool, str, Optional[ApiKey], int]:
        success, error, api_key, amount = self.prepare_redeem(full_key)
        if not success or not api_key:
            return success, error, api_key, amount
        if not self.mark_redeemed(api_key.key, user_id):
            return False, "兑换码已被使用", None, 0
        return True, "", self.get_key(api_key.key), amount

    def prepare_redeem(self, full_key: str) -> tuple[bool, str, Optional[ApiKey], int]:
        with self._lock:
            api_key = self.verify_key(full_key)
            if not api_key:
                return False, "兑换码无效", None, 0
            if api_key.is_admin:
                return False, "管理员密钥不能兑换", None, 0
            if not api_key.enabled:
                return False, "兑换码已停用", None, 0
            if api_key.expires_at > 0 and int(time.time()) > api_key.expires_at:
                return False, "兑换码已过期", None, 0
            if api_key.redeemed_at > 0:
                return False, "兑换码已被使用", None, 0
            amount = api_key.redeem_amount()
            if amount <= 0:
                return False, "兑换积分必须大于 0", None, 0
            return True, "", api_key, amount

    def mark_redeemed(self, key: str, user_id: str) -> bool:
        with self._lock:
            api_key = self._keys.get(key)
            if not api_key or api_key.redeemed_at > 0:
                return False
            api_key.redeemed_by = user_id
            api_key.redeemed_at = int(time.time())
            api_key.total_usage = 1
            self._save()
            return True, "", api_key, amount

    def validate_and_use(self, full_key: str) -> tuple[bool, str, Optional[ApiKey]]:
        """
        验证密钥并扣减 1 次使用次数
        返回: (是否成功, 错误信息, ApiKey对象)
        """
        success, error, api_key = self.validate_key(full_key)
        if not success or not api_key:
            return success, error, api_key

        api_key.total_usage += 1
        self._save()
        return True, "", api_key

    def increment_usage(self, key: str, amount: int = 1) -> bool:
        """按次数扣减配额，只有成功生成后才调用"""
        if amount <= 0:
            return True

        with self._lock:
            api_key = self._keys.get(key)
            if not api_key:
                return False

            api_key.total_usage += amount
            self._save()
        return True

    def get_key(self, key: str) -> Optional[ApiKey]:
        """获取密钥信息"""
        with self._lock:
            return self._keys.get(key)

    def list_keys(self, include_disabled: bool = True) -> list[dict]:
        """列出所有密钥"""
        with self._lock:
            keys = []
            for api_key in self._keys.values():
                if not include_disabled and not api_key.enabled:
                    continue
                keys.append(api_key.to_dict())
            return keys

    def update_key(self, key: str, **kwargs) -> bool:
        """更新密钥设置"""
        with self._lock:
            api_key = self._keys.get(key)
            if not api_key:
                return False

            for k, v in kwargs.items():
                if hasattr(api_key, k):
                    setattr(api_key, k, v)

            self._save()
            return True

    def delete_key(self, key: str) -> bool:
        """删除密钥"""
        with self._lock:
            api_key = self._keys.pop(key, None)
            if api_key and api_key.secret_hash:
                self._secret_index.pop(api_key.secret_hash, None)
            self._save()
            return api_key is not None

    def reset_usage(self, key: str) -> bool:
        """重置兑换码状态，让未过期且启用的兑换码可再次兑换。"""
        with self._lock:
            api_key = self._keys.get(key)
            if not api_key:
                return False
            api_key.total_usage = 0
            if not api_key.is_admin:
                api_key.redeemed_by = ""
                api_key.redeemed_at = 0
            self._save()
            return True


# 单例实例
api_key_service = ApiKeyService()
