"""Themes are consumed by both native PowerPoint and template previews."""
TEMPLATES = [
    {"id": "business", "name": "雾白商务", "description": "季度汇报 · 数据总结", "background": "F8FAFC", "foreground": "172033", "accent": "4F46E5", "muted": "64748B"},
    {"id": "product", "name": "青绿产品", "description": "产品介绍 · 品牌展示", "background": "102C2B", "foreground": "F0FDFA", "accent": "5EEAD4", "muted": "A3C4BE"},
    {"id": "proposal", "name": "暖砂方案", "description": "项目提案 · 创意策划", "background": "FCF7EF", "foreground": "3E2C21", "accent": "C1673F", "muted": "846F60"},
    {"id": "education", "name": "晴蓝课堂", "description": "教学课件 · 培训分享", "background": "EFF8FF", "foreground": "14324A", "accent": "0284C7", "muted": "52738A"},
]


def get_template(template_id):
    return next(t for t in TEMPLATES if t["id"] == template_id)
