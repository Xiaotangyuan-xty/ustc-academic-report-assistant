#!/usr/bin/env python3
"""Generic local SMTP helper for the USTC report monitor extension.

Each user configures their own sender and recipient. Authorization codes are
stored in macOS Keychain, never in this file or the browser extension.
Only browser-extension origins may call the local HTTP endpoint.
"""

import argparse
import getpass
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import smtplib
import ssl
import subprocess
import sys
import threading
import time
import uuid
from email.message import EmailMessage
from email.utils import formatdate
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen

DEFAULT_SMTP_HOST = "smtp.163.com"
DEFAULT_SMTP_PORT = 465
KEYCHAIN_SERVICE = "local.ustc-report-monitor.smtp"
HTTP_HOST = "127.0.0.1"
HTTP_PORT = 17826
LAUNCH_AGENT_LABEL = "local.ustc-report-monitor.email"
SCRIPT_PATH = Path(__file__).resolve()
STATE_DIR = Path.home() / "Library" / "Application Support" / "UstcReportMonitor"
CONFIG_FILE = STATE_DIR / "email-config.json"
LEGACY_SENT_FILE = STATE_DIR / "sent-report-ids.json"
PLIST_PATH = Path.home() / "Library" / "LaunchAgents" / f"{LAUNCH_AGENT_LABEL}.plist"
SEND_LOCK = threading.Lock()


def clean_text(value, field, maximum=500, required=True):
    if value is None:
        value = ""
    if not isinstance(value, str):
        value = str(value)
    value = re.sub(r"[\r\n]+", " ", value).strip()
    if required and not value:
        raise ValueError(f"缺少字段：{field}")
    if len(value) > maximum:
        raise ValueError(f"字段过长：{field}")
    return value


def clean_email(value, field):
    value = clean_text(value, field, 320)
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", value):
        raise ValueError(f"{field}格式无效")
    return value


def normalize_config(payload):
    if not isinstance(payload, dict):
        raise ValueError("邮箱配置格式无效")
    host = clean_text(payload.get("smtpHost") or DEFAULT_SMTP_HOST, "SMTP 服务器", 253)
    if not re.fullmatch(r"[A-Za-z0-9.-]+", host):
        raise ValueError("SMTP 服务器格式无效")
    try:
        port = int(payload.get("smtpPort") or DEFAULT_SMTP_PORT)
    except (TypeError, ValueError) as error:
        raise ValueError("SMTP 端口格式无效") from error
    if not 1 <= port <= 65535:
        raise ValueError("SMTP 端口超出范围")
    return {
        "sender": clean_email(payload.get("sender"), "发件邮箱"),
        "recipient": clean_email(payload.get("recipient"), "收件邮箱"),
        "smtpHost": host,
        "smtpPort": port,
    }


def load_config(required=True):
    if not CONFIG_FILE.exists():
        if required:
            raise RuntimeError("尚未配置邮箱，请运行 email_helper.py --setup")
        return None
    with CONFIG_FILE.open("r", encoding="utf-8") as handle:
        return normalize_config(json.load(handle))


def save_config(config):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    temporary = CONFIG_FILE.with_suffix(".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(config, handle, ensure_ascii=False, indent=2)
    os.chmod(temporary, 0o600)
    temporary.replace(CONFIG_FILE)


def sent_file_for(config):
    identity = f"{config['sender']}\n{config['recipient']}".encode("utf-8")
    digest = hashlib.sha256(identity).hexdigest()[:20]
    return STATE_DIR / f"sent-{digest}.json"


def normalize_report(payload):
    if not isinstance(payload, dict):
        raise ValueError("请求内容必须是 JSON 对象")
    report_id = clean_text(payload.get("id"), "id", 128)
    if not re.fullmatch(r"[A-Za-z0-9_-]+", report_id):
        raise ValueError("报告编码格式无效")
    return {
        "id": report_id,
        "title": clean_text(payload.get("title"), "title", 500),
        "location": clean_text(payload.get("location"), "location", 500),
        "reportTime": clean_text(payload.get("reportTime"), "reportTime", 100, False),
        "deadline": clean_text(payload.get("deadline"), "deadline", 100, False),
    }


def build_message(report, config):
    message = EmailMessage()
    message["From"] = config["sender"]
    message["To"] = config["recipient"]
    message["Subject"] = f"学术报告选课成功：{report['title']}"
    message["Date"] = formatdate(localtime=True)
    message["Message-ID"] = f"<ustc-report-{report['id']}@localhost>"
    message.set_content(
        "你的学术报告已选课成功。\n\n"
        f"报告题目：{report['title']}\n"
        f"举办地点：{report['location']}\n"
        f"报告时间：{report['reportTime'] or '未提供'}\n"
        f"选课截止：{report['deadline'] or '未提供'}\n\n"
        "此邮件由本机学术报告监控扩展自动发送。"
    )
    return message


def stored_authorization_code(sender):
    result = subprocess.run(
        [
            "security", "find-generic-password",
            "-a", sender,
            "-s", KEYCHAIN_SERVICE,
            "-w",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return None
    return result.stdout.rstrip("\r\n") or None


def smtp_deliver(message, config):
    password = stored_authorization_code(config["sender"])
    if not password:
        raise RuntimeError("钥匙串中没有该发件邮箱的 SMTP 授权码，请重新运行 --setup")

    context = ssl.create_default_context()
    with smtplib.SMTP_SSL(config["smtpHost"], config["smtpPort"], timeout=20, context=context) as smtp:
        smtp.login(config["sender"], password)
        smtp.send_message(message)


def read_sent_ids(state_file):
    if not state_file.exists():
        return []
    with state_file.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, list):
        raise ValueError("本地邮件状态文件格式无效")
    return [str(item) for item in data]


def write_sent_ids(state_file, sent_ids):
    state_file.parent.mkdir(parents=True, exist_ok=True)
    temporary = state_file.with_suffix(".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(sent_ids[-1000:], handle, ensure_ascii=False)
    os.chmod(temporary, 0o600)
    temporary.replace(state_file)


def send_report(payload, state_file=None):
    report = normalize_report(payload)
    config = load_config()
    destination = state_file or sent_file_for(config)
    with SEND_LOCK:
        sent_ids = read_sent_ids(destination)
        if report["id"] in sent_ids:
            return {"ok": True, "alreadySent": True}

        smtp_deliver(build_message(report, config), config)
        sent_ids.append(report["id"])
        write_sent_ids(destination, sent_ids)
        return {"ok": True, "alreadySent": False}


def valid_origin(origin):
    return bool(origin and origin.startswith("chrome-extension://"))


def valid_health_origin(origin):
    # Chrome extension GET requests may omit Origin. The response has no CORS
    # header in that case, so ordinary websites still cannot read its contents.
    return origin in ("", "null") or valid_origin(origin)


class EmailRequestHandler(BaseHTTPRequestHandler):
    server_version = "UstcReportEmail/1.0"

    def json_response(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        origin = self.headers.get("Origin", "")
        if valid_origin(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        if not valid_origin(self.headers.get("Origin", "")):
            self.json_response(403, {"ok": False, "error": "不允许的来源"})
            return
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", self.headers["Origin"])
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Vary", "Origin")
        self.end_headers()

    def do_GET(self):
        if self.path != "/health" or not valid_health_origin(self.headers.get("Origin", "")):
            self.json_response(403, {"ok": False, "error": "不允许的来源或路径"})
            return
        try:
            config = load_config(required=False)
        except Exception:
            config = None
        payload = {"ok": True, "service": "ustc-report-email", "configured": bool(config)}
        if config:
            payload.update({
                "sender": config["sender"],
                "recipient": config["recipient"],
                "smtpHost": config["smtpHost"],
                "smtpPort": config["smtpPort"],
            })
        self.json_response(200, payload)

    def do_POST(self):
        if self.path != "/send" or not valid_origin(self.headers.get("Origin", "")):
            self.json_response(403, {"ok": False, "error": "不允许的来源或路径"})
            return
        if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
            self.json_response(415, {"ok": False, "error": "Content-Type 必须是 application/json"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 16384:
                raise ValueError("请求内容为空或过大")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            self.json_response(200, send_report(payload))
        except ValueError as error:
            self.json_response(400, {"ok": False, "error": str(error)})
        except Exception as error:
            self.json_response(500, {"ok": False, "error": f"邮件发送失败：{str(error)[:400]}"})


def install_launch_agent():
    PLIST_PATH.parent.mkdir(parents=True, exist_ok=True)
    plist = {
        "Label": LAUNCH_AGENT_LABEL,
        "ProgramArguments": [sys.executable, str(SCRIPT_PATH), "--serve"],
        "WorkingDirectory": str(SCRIPT_PATH.parent),
        "RunAtLoad": True,
        "KeepAlive": True,
        "ProcessType": "Background",
        "StandardOutPath": "/tmp/ustc-report-monitor-email.out.log",
        "StandardErrorPath": "/tmp/ustc-report-monitor-email.error.log",
    }
    with PLIST_PATH.open("wb") as handle:
        plistlib.dump(plist, handle)

    domain = f"gui/{os.getuid()}"
    subprocess.run(
        ["launchctl", "bootout", f"{domain}/{LAUNCH_AGENT_LABEL}"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    subprocess.run(["launchctl", "bootstrap", domain, str(PLIST_PATH)], check=True)


def prompt_default(label, default=""):
    suffix = f" [{default}]" if default else ""
    return input(f"{label}{suffix}：").strip() or default


def setup(args):
    if sys.platform != "darwin":
        raise RuntimeError("当前安装脚本使用 macOS 钥匙串和 launchd，仅支持 macOS")
    existing = load_config(required=False) or {}
    sender = args.sender or prompt_default("发件邮箱", existing.get("sender", ""))
    recipient = args.recipient or prompt_default("收件邮箱", existing.get("recipient", sender))
    smtp_host = args.smtp_host or prompt_default("SMTP 服务器", existing.get("smtpHost", DEFAULT_SMTP_HOST))
    smtp_port = args.smtp_port or prompt_default("SMTP SSL 端口", str(existing.get("smtpPort", DEFAULT_SMTP_PORT)))
    config = normalize_config({
        "sender": sender,
        "recipient": recipient,
        "smtpHost": smtp_host,
        "smtpPort": smtp_port,
    })

    if args.reset_credential or not stored_authorization_code(config["sender"]):
        authorization_code = getpass.getpass("请输入发件邮箱的 SMTP 授权码（不是登录密码，输入不会回显）：").strip()
        if not authorization_code:
            raise ValueError("授权码不能为空")
        subprocess.run(
            [
                "security", "add-generic-password", "-U",
                "-a", config["sender"],
                "-s", KEYCHAIN_SERVICE,
                "-w", authorization_code,
            ],
            check=True,
        )
    else:
        print("检测到该发件邮箱已有钥匙串授权码，将沿用现有授权码。")

    save_config(config)
    destination = sent_file_for(config)
    if not existing and LEGACY_SENT_FILE.exists() and not destination.exists():
        LEGACY_SENT_FILE.replace(destination)
    install_launch_agent()

    health_url = f"http://{HTTP_HOST}:{HTTP_PORT}/health"
    for _ in range(30):
        try:
            request = Request(health_url, headers={"Origin": "chrome-extension://setup"})
            with urlopen(request, timeout=1) as response:
                if response.status == 200:
                    print("配置完成，本地邮件助手已启动并设为登录时自动运行。")
                    print(f"成功邮件将由 {config['sender']} 发送到 {config['recipient']}。")
                    print("可运行 --test 发送一封真实测试邮件。")
                    return
        except Exception:
            time.sleep(0.2)
    raise RuntimeError("配置已保存，但本地邮件助手尚未通过健康检查，请查看 /tmp 日志")


def send_test():
    config = load_config()
    result = send_report({
        "id": f"test-{uuid.uuid4()}",
        "title": "本地邮件助手测试",
        "location": "测试地点",
        "reportTime": "这是一封测试邮件",
        "deadline": "无需操作",
    })
    print(f"测试邮件已发送到 {config['recipient']}。" if not result.get("alreadySent") else "测试邮件此前已发送。")


def serve():
    server = ThreadingHTTPServer((HTTP_HOST, HTTP_PORT), EmailRequestHandler)
    server.daemon_threads = True
    print(f"本地邮件助手正在监听 http://{HTTP_HOST}:{HTTP_PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def main():
    parser = argparse.ArgumentParser(description="USTC 学术报告选课成功邮件助手（多人通用版）")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--setup", action="store_true", help="配置邮箱并安装本地助手")
    group.add_argument("--serve", action="store_true", help="前台运行本地助手")
    group.add_argument("--test", action="store_true", help="真实发送一封测试邮件")
    parser.add_argument("--sender", help="发件邮箱；不传则交互询问")
    parser.add_argument("--recipient", help="收件邮箱；不传则交互询问")
    parser.add_argument("--smtp-host", help=f"SMTP 服务器，默认 {DEFAULT_SMTP_HOST}")
    parser.add_argument("--smtp-port", type=int, help=f"SMTP SSL 端口，默认 {DEFAULT_SMTP_PORT}")
    parser.add_argument("--reset-credential", action="store_true", help="重新输入并替换钥匙串中的授权码")
    args = parser.parse_args()
    try:
        if args.setup:
            setup(args)
        elif args.test:
            send_test()
        else:
            serve()
    except Exception as error:
        print(f"错误：{error}", file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
