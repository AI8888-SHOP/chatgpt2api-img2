from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import threading
from pathlib import Path
from typing import Callable

from services.account_service import account_service
from services.config import DATA_DIR


PROJECT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_BUNDLE = PROJECT_DIR / "codex_register" / "bundle" / "index.cjs"
RUNTIME_DIR = DATA_DIR / "codex-register"
CODEX_PROVIDERS = {"cloudflare", "gmail", "hotmail"}
LEGACY_MAIL_PROVIDERS = {
    "cloudflare_temp_email",
    "tempmail_lol",
    "duckmail",
    "gptmail",
    "moemail",
    "yyds_mail",
}
SUPPORTED_PROVIDERS = CODEX_PROVIDERS | LEGACY_MAIL_PROVIDERS


class CodexRegisterRunner:
    def __init__(self, log_sink: Callable[[str, str], None]):
        self._log_sink = log_sink
        self._lock = threading.RLock()
        self._process: subprocess.Popen[str] | None = None

    def stop(self) -> None:
        with self._lock:
            process = self._process
        if not process or process.poll() is not None:
            return
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            process.terminate()

    def run(self, config: dict, *, force_output_mode: str | None = None) -> dict[str, int]:
        bundle = Path(os.environ.get("CODEX_REGISTER_BUNDLE") or DEFAULT_BUNDLE)
        node = shutil.which("node")
        if not node:
            raise RuntimeError("Codex 注册器需要 Node.js 20+，当前运行环境未找到 node")
        if not bundle.is_file():
            raise RuntimeError(f"Codex 注册器 bundle 不存在: {bundle}")

        codex = config.get("codex") if isinstance(config.get("codex"), dict) else {}
        output_mode = str(force_output_mode or codex.get("output_mode") or "chatgpt").strip().lower()
        provider = self.resolve_provider(config, output_mode=output_mode)
        password = str(codex.get("default_password") or config.get("default_password") or "").strip()
        if provider not in SUPPORTED_PROVIDERS:
            raise RuntimeError(f"不支持的 Codex 邮箱 Provider: {provider}")
        if output_mode not in {"chatgpt", "codex"}:
            raise RuntimeError(f"不支持的 Codex 输出模式: {output_mode}")
        if not password:
            password = "kuaileshifu88"

        runtime_config = {
            "provider": provider,
            "defaultProxyUrl": str(config.get("proxy") or "").strip(),
            "defaultPassword": password,
            "loopDelayMs": max(0, int(codex.get("loop_delay_ms") or 0)),
            "gmailAccessToken": str(codex.get("gmail_access_token") or "").strip(),
            "gmailEmailAddress": str(codex.get("gmail_email_address") or "").strip(),
            "cloudflareEmailDomain": str(codex.get("cloudflare_email_domain") or "").strip(),
            "cloudflareApiBaseUrl": str(codex.get("cloudflare_api_base_url") or "").strip(),
            "cloudflareApiKey": str(codex.get("cloudflare_api_key") or "").strip(),
            "cliproxyApiAutoUploadAuth": bool(codex.get("cliproxy_auto_upload")),
            "cliproxyApiBaseUrl": str(codex.get("cliproxy_api_base_url") or "").strip(),
            "cliproxyApiManagementKey": str(codex.get("cliproxy_management_key") or "").strip(),
            "mail": config.get("mail") if isinstance(config.get("mail"), dict) else {},
        }
        self._validate_provider(runtime_config)
        self._prepare_runtime(runtime_config, str(codex.get("hotmail_tokens") or ""))

        command = [
            node,
            str(bundle),
            "--at" if output_mode == "chatgpt" else "--sign",
            "--n",
            str(max(1, int(config.get("total") or 1))),
        ]
        threads = max(1, int(config.get("threads") or 1))
        if provider == "hotmail" and threads > 1:
            command.extend(["--threads", str(threads)])

        secrets = self._secret_values(runtime_config, str(codex.get("hotmail_tokens") or ""))
        success = 0
        fail = 0
        process = subprocess.Popen(
            command,
            cwd=RUNTIME_DIR,
            env={**os.environ, "NO_COLOR": "1"},
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            start_new_session=True,
        )
        with self._lock:
            self._process = process

        try:
            assert process.stdout is not None
            for raw_line in process.stdout:
                line = raw_line.rstrip()
                if not line:
                    continue
                token = self._extract_access_token(line)
                if token:
                    account_service.add_account(
                        token,
                        {"type": "Free", "status": "正常", "quota": 0, "source_type": "codex-register"},
                    )
                    try:
                        account_service.refresh_accounts([token])
                    except Exception as exc:
                        self._log_sink(f"Codex 注册账号已导入，刷新账号信息失败: {exc}", "yellow")
                    success += 1
                    self._log_sink("Codex 注册账号已导入当前号池", "green")
                    continue
                if output_mode == "codex" and "授权成功" in line:
                    success += 1
                if "授权失败" in line or re.search(r"\[失败\]", line):
                    fail += 1
                self._log_sink(self._redact(line, secrets), self._line_level(line))
            return_code = process.wait()
        finally:
            with self._lock:
                if self._process is process:
                    self._process = None

        if return_code != 0 and fail == 0:
            fail = 1
        return {"success": success, "fail": fail, "return_code": return_code}

    @staticmethod
    def _resolve_provider(config: dict, codex: dict, output_mode: str) -> str:
        configured = str(codex.get("provider") or "").strip().lower()
        if output_mode == "codex" or str(config.get("engine") or "").strip().lower() == "codex":
            return configured or "cloudflare"

        mail = config.get("mail") if isinstance(config.get("mail"), dict) else {}
        providers = mail.get("providers") if isinstance(mail.get("providers"), list) else []
        for item in providers:
            if not isinstance(item, dict) or not item.get("enable"):
                continue
            provider = str(item.get("type") or "").strip().lower()
            if provider in SUPPORTED_PROVIDERS:
                return provider
        return configured or "cloudflare"

    @classmethod
    def resolve_provider(cls, config: dict, *, output_mode: str | None = None) -> str:
        codex = config.get("codex") if isinstance(config.get("codex"), dict) else {}
        effective_output_mode = str(output_mode or codex.get("output_mode") or "chatgpt").strip().lower()
        return cls._resolve_provider(config, codex, effective_output_mode)

    @staticmethod
    def _validate_provider(config: dict) -> None:
        provider = config["provider"]
        if provider == "cloudflare":
            required = {
                "Cloudflare 邮箱域名": config["cloudflareEmailDomain"],
                "Cloudflare Worker 地址": config["cloudflareApiBaseUrl"],
                "Cloudflare Worker API Key": config["cloudflareApiKey"],
            }
        elif provider == "gmail":
            required = {
                "Gmail 地址": config["gmailEmailAddress"],
                "Gmail Access Token": config["gmailAccessToken"],
            }
        elif provider == "hotmail":
            required = {}
            # tokens may be Outlook token lines or web-otp lines: email----https://...
        else:
            mail = config.get("mail") if isinstance(config.get("mail"), dict) else {}
            providers = mail.get("providers") if isinstance(mail.get("providers"), list) else []
            enabled = [
                item
                for item in providers
                if isinstance(item, dict)
                and item.get("enable")
                and str(item.get("type") or "").strip().lower() == provider
            ]
            if not enabled:
                raise RuntimeError(f"mail.providers 未启用 {provider}")
            required = {}
        missing = [name for name, value in required.items() if not str(value or "").strip()]
        if missing:
            raise RuntimeError(f"Codex 注册配置缺少: {', '.join(missing)}")

    @staticmethod
    def _prepare_runtime(config: dict, hotmail_tokens: str) -> None:
        RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
        config_file = RUNTIME_DIR / "config.json"
        config_file.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        config_file.chmod(0o600)
        hotmail_dir = RUNTIME_DIR / "hotmail"
        hotmail_dir.mkdir(parents=True, exist_ok=True)
        tokens_file = hotmail_dir / "tokens.txt"
        tokens_file.write_text(hotmail_tokens.strip() + ("\n" if hotmail_tokens.strip() else ""), encoding="utf-8")
        tokens_file.chmod(0o600)
        (RUNTIME_DIR / "auth").mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _extract_access_token(line: str) -> str:
        marker = "[access_token]"
        if marker not in line:
            return ""
        return line.split(marker, 1)[1].strip().lstrip(":").strip()

    @staticmethod
    def _secret_values(config: dict, hotmail_tokens: str) -> list[str]:
        values = [
            config.get("defaultPassword"),
            config.get("gmailAccessToken"),
            config.get("cloudflareApiKey"),
            config.get("cliproxyApiManagementKey"),
        ]
        for line in hotmail_tokens.splitlines():
            values.extend(line.split("----")[1:])
        return sorted({str(value) for value in values if len(str(value or "")) >= 6}, key=len, reverse=True)

    @staticmethod
    def _redact(line: str, secrets: list[str]) -> str:
        redacted = line
        for secret in secrets:
            redacted = redacted.replace(secret, "***")
        redacted = re.sub(r"(\[access_token\]\s*:?).+", r"\1 ***", redacted)
        return redacted

    @staticmethod
    def _line_level(line: str) -> str:
        if "失败" in line or "Error" in line or "error=" in line:
            return "red"
        if "成功" in line or "Uploaded" in line:
            return "green"
        if "延迟" in line or "重试" in line or "warning" in line.lower():
            return "yellow"
        return "info"
