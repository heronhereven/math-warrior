import argparse
import json
import threading
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

from desktop_runtime import PeriodicSyncWorker, ensure_json_template, open_external, save_json_config, resource_root, wait_for_health
from github_sync_client import local_app_root, run_once as sync_client_once
from server import MathQuestApp


APP_TITLE = "Math Quest Desktop"


def build_math_quest_app(port: int = 0, desktop_bridge=None) -> MathQuestApp:
    data_root = local_app_root()
    data_root.mkdir(parents=True, exist_ok=True)
    return MathQuestApp(
        db_path=data_root / "math-quest.db",
        static_dir=resource_root(),
        upload_dir=data_root / "uploads",
        sync_signal_path=data_root / "sync-now.flag",
        desktop_bridge=desktop_bridge,
        admin_username="admin",
        admin_password="admin123456",
        host="127.0.0.1",
        port=port,
    )


class DesktopLauncher:
    kind = "learner"
    title = "泡面侠训练站桌面版"
    action_label = "打开训练站"
    copy = "双击后会启动本地训练站。第一次使用时，把 GitHub 私有仓库信息填进去保存就行。"

    def __init__(self) -> None:
        self.data_root = local_app_root()
        self.data_root.mkdir(parents=True, exist_ok=True)
        self.config_path = self.data_root / "github-sync.json"
        self.state_path = self.data_root / "launcher-state.json"
        self.server: ThreadingHTTPServer | None = None
        self.server_thread: threading.Thread | None = None
        self.sync_worker: PeriodicSyncWorker | None = None
        self.url = ""
        self.control_url = ""
        self.status_message = "正在启动泡面侠训练站..."
        self.sync_status = "GitHub 同步尚未配置"
        self.stop_event = threading.Event()

    def _config_template(self) -> dict:
        return {
            "enabled": False,
            "owner": "xiaohe-account",
            "repo": "math-quest-sync",
            "branch": "main",
            "token": "ghp_replace_me",
            "interval": 300,
            "username": "",
        }

    def _load_config(self) -> dict:
        return ensure_json_template(self.config_path, self._config_template())

    def _sync_ready(self, config: dict) -> bool:
        token = str(config.get("token", "")).strip()
        return bool(
            config.get("enabled")
            and str(config.get("owner", "")).strip()
            and str(config.get("repo", "")).strip()
            and token
            and token != "ghp_replace_me"
        )

    def _sync_args(self, config: dict) -> SimpleNamespace:
        return SimpleNamespace(
            owner=str(config.get("owner", "")).strip(),
            repo=str(config.get("repo", "")).strip(),
            branch=str(config.get("branch", "main")).strip() or "main",
            token=str(config.get("token", "")).strip(),
            db=str(self.data_root / "math-quest.db"),
            upload_dir=str(self.data_root / "uploads"),
            username=str(config.get("username", "")).strip() or None,
            interval=int(config.get("interval", 300) or 300),
            once=True,
        )

    def _set_sync_status(self, message: str, is_error: bool = False) -> None:
        self.sync_status = f"同步异常： {message}" if is_error else message

    def _run_sync_once(self) -> str:
        config = self._load_config()
        if not self._sync_ready(config):
            return "还没填好 GitHub 同步信息。点“保存设置”把仓库信息填好就行。"
        return sync_client_once(self._sync_args(config))

    def _setup_sync(self) -> None:
        config = self._load_config()
        if not self._sync_ready(config):
            self.sync_status = "还没配置 GitHub 同步。先把仓库信息填好，再点“立即同步”或直接开始使用。"
            return
        if self.sync_worker is not None:
            self.sync_worker.stop()
        self.sync_worker = PeriodicSyncWorker(
            name="github-client-sync",
            interval=int(config.get("interval", 300) or 300),
            sync_once=self._run_sync_once,
            on_status=self._set_sync_status,
            signal_path=self.data_root / "sync-now.flag",
        )
        self.sync_worker.start()
        self.sync_status = "GitHub 同步已启动，正在后台轮询。"

    def _save_state_file(self) -> None:
        save_json_config(
            self.state_path,
            {
                "base_url": self.url,
                "control_url": self.control_url,
            },
        )

    def _reopen_existing(self) -> bool:
        if not self.state_path.exists():
            return False
        try:
            payload = json.loads(self.state_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return False
        base_url = str(payload.get("base_url", "")).strip()
        control_url = str(payload.get("control_url", "")).strip()
        if not base_url or not control_url:
            return False
        try:
            wait_for_health(base_url, timeout_seconds=1.0)
        except Exception:
            return False
        open_external(control_url)
        return True

    def desktop_meta(self) -> dict:
        config = self._load_config()
        return {
            "kind": self.kind,
            "title": self.title,
            "copy": self.copy,
            "action_label": self.action_label,
            "status_message": self.status_message,
            "sync_status": self.sync_status,
            "include_username": True,
            "ready": self._sync_ready(config),
            "config": config,
        }

    def desktop_save_config(self, payload: dict) -> dict:
        config = self._config_template()
        current = self._load_config()
        config.update(current)
        config["enabled"] = bool(payload.get("enabled"))
        config["owner"] = str(payload.get("owner", "")).strip()
        config["repo"] = str(payload.get("repo", "")).strip()
        config["branch"] = str(payload.get("branch", "main")).strip() or "main"
        config["token"] = str(payload.get("token", "")).strip()
        config["username"] = str(payload.get("username", "")).strip()
        try:
            config["interval"] = max(30, int(payload.get("interval", 300) or 300))
        except (TypeError, ValueError):
            config["interval"] = 300
        save_json_config(self.config_path, config)
        self._setup_sync()
        self.sync_status = "同步设置已经保存。"
        return self.desktop_meta()

    def desktop_trigger_sync(self) -> dict:
        config = self._load_config()
        if not self._sync_ready(config):
            self.sync_status = "同步信息还没填完。先把仓库信息补齐。"
            return self.desktop_meta()
        if self.sync_worker is None:
            self._setup_sync()
        if self.sync_worker is not None:
            self.sync_status = "正在手动触发一次同步..."
            self.sync_worker.trigger_now()
        return self.desktop_meta()

    def desktop_shutdown(self) -> None:
        threading.Thread(target=self.close, daemon=True).start()

    def start(self) -> int:
        if self._reopen_existing():
            return 0
        app = build_math_quest_app(port=0, desktop_bridge=self)
        self.server = app.create_server()
        port = self.server.server_address[1]
        self.url = f"http://127.0.0.1:{port}"
        self.control_url = f"{self.url}/desktop-control"
        self.server_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.server_thread.start()
        self._setup_sync()
        wait_for_health(self.url, timeout_seconds=8)
        self.status_message = "训练站已经准备好了。可以先在控制台里保存同步设置，再打开训练站。"
        self._save_state_file()
        open_external(self.control_url)
        self.stop_event.wait()
        return 0

    def close(self) -> None:
        if self.sync_worker is not None:
            self.sync_worker.stop()
            self.sync_worker = None
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()
            self.server = None
        if self.server_thread is not None:
            self.server_thread.join(timeout=3)
            self.server_thread = None
        self.state_path.unlink(missing_ok=True)
        self.stop_event.set()


def smoke_test() -> int:
    launcher = DesktopLauncher()
    app = build_math_quest_app(port=0, desktop_bridge=launcher)
    server = app.create_server()
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{port}"
    try:
        wait_for_health(base_url, timeout_seconds=5)
        with urllib.request.urlopen(f"{base_url}/desktop-control", timeout=2) as response:
            html = response.read().decode("utf-8")
        if "desktop control" not in html.lower():
            raise RuntimeError("桌面控制台内容不对")
        with urllib.request.urlopen(f"{base_url}/api/desktop/meta", timeout=2) as response:
            payload = json.loads(response.read().decode("utf-8"))
        if payload.get("kind") != "learner":
            raise RuntimeError("桌面控制台元数据不对")
        print(f"smoke-ok {base_url}")
        return 0
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)


def main() -> int:
    parser = argparse.ArgumentParser(description="Math Quest 泡面侠桌面启动器")
    parser.add_argument("--smoke-test", action="store_true", help="仅做一次启动自检")
    args = parser.parse_args()
    if args.smoke_test:
        return smoke_test()
    launcher = DesktopLauncher()
    return launcher.start()


if __name__ == "__main__":
    raise SystemExit(main())
