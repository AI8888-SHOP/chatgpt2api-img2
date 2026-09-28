from __future__ import annotations

import json
import sys
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from services.register import mail_provider  # noqa: E402


def _load_mail_config(config_path: str) -> dict:
    raw = json.loads(Path(config_path).read_text(encoding="utf-8"))
    mail = raw.get("mail")
    return mail if isinstance(mail, dict) else {}


def _read_payload() -> dict:
    raw = sys.stdin.read().strip()
    if not raw:
        return {}
    payload = json.loads(raw)
    return payload if isinstance(payload, dict) else {}


def main() -> int:
    if len(sys.argv) < 3:
        print(json.dumps({"error": "usage: mail_provider_bridge.py <action> <config_path>"}), file=sys.stderr)
        return 2

    action = str(sys.argv[1]).strip()
    config_path = str(sys.argv[2]).strip()
    mail_config = _load_mail_config(config_path)
    payload = _read_payload()

    if action == "create_mailbox":
        username = payload.get("username")
        result = mail_provider.create_mailbox(
            mail_config,
            username if isinstance(username, str) and username.strip() else None,
        )
        print(json.dumps({"mailbox": result}, ensure_ascii=False))
        return 0

    if action == "wait_for_code":
        mailbox = payload.get("mailbox")
        if not isinstance(mailbox, dict):
            print(json.dumps({"error": "mailbox is required"}), file=sys.stderr)
            return 2
        code = mail_provider.wait_for_code(mail_config, mailbox)
        print(json.dumps({"code": code, "mailbox": mailbox}, ensure_ascii=False))
        return 0

    print(json.dumps({"error": f"unsupported action: {action}"}), file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
