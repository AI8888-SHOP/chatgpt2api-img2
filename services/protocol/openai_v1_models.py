from __future__ import annotations

from typing import Any

from services.openai_backend_api import OpenAIBackendAPI


DYNAMIC_MODEL_IDS = (
    "gpt-image-2",
    "grok-imagine-image",
    "gptfree",
    "gptfree/gpt-5.6-sol",
    "gptfree/gpt-5.6-luna",
    "gptfree/gpt-5.6-terra",
)


def list_models() -> dict[str, Any]:
    result = OpenAIBackendAPI().list_models()
    data = result.get("data")
    if not isinstance(data, list):
        return result
    seen = {str(item.get("id") or "").strip() for item in data if isinstance(item, dict)}
    for model in DYNAMIC_MODEL_IDS:
        if model not in seen:
            data.append({
                "id": model,
                "object": "model",
                "created": 0,
                "owned_by": "chatgpt2api",
                "permission": [],
                "root": model,
                "parent": None,
            })
    return result
