"""管理员密钥初始化服务"""

from services.api_key_service import api_key_service


def init_default_admin_key():
    """初始化默认管理员密钥
    
    如果不存在任何管理员密钥，自动创建一个默认管理员密钥。
    返回创建的密钥或 None（如果已有管理员密钥）。
    """
    # 检查是否已存在管理员密钥
    keys = api_key_service.list_keys(include_disabled=True)
    admin_keys = [k for k in keys if k.get("is_admin", False)]
    
    if admin_keys:
        print("[admin_init] Admin key already exists, skipping default key creation.")
        return None
    
    # 创建默认管理员密钥
    default_key, api_key = api_key_service.generate_key(
        name="Default Admin Key",
        max_usage=-1,  # 无限使用
        expires_days=0,  # 永不过期
        is_admin=True
    )
    
    print(f"[admin_init] Created default admin key: {default_key}")
    return default_key


# 应用启动时自动初始化
if __name__ == "__main__":
    key = init_default_admin_key()
    if key:
        print("\n" + "=" * 60)
        print("⚠️  默认管理员密钥已创建，请妥善保管！")
        print("=" * 60)
        print(f"\n完整密钥: {key}\n")
        print("建议立即登录管理后台修改此密钥。")
        print("=" * 60)
