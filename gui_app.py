import argparse
import threading
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from tkinter import BOTH, LEFT, RIGHT, X, Button, Frame, Label, StringVar, Tk
from types import SimpleNamespace

from desktop_runtime import PeriodicSyncWorker, ensure_json_template, open_external, resource_root, wait_for_health
from github_sync_client import local_app_root, run_once as sync_client_once
from server import MathQuestApp


APP_TITLE = "Math Quest Desktop"


def build_math_quest_app(port: int = 0) -> MathQuestApp:
    data_root = local_app_root()
    data_root.mkdir(parents=True, exist_ok=True)
    return MathQuestApp(
        db_path=data_root / "math-quest.db",
        static_dir=resource_root(),
        upload_dir=data_root / "uploads",
        sync_signal_path=data_root / "sync-now.flag",
        admin_username="admin",
        admin_password="admin123456",
        host="127.0.0.1",
        port=port,
    )


class DesktopWindow:
    def __init__(self) -> None:
        self.data_root = local_app_root()
        self.data_root.mkdir(parents=True, exist_ok=True)
        self.config_path = self.data_root / "github-sync.json"
        self.root = Tk()
        self.root.title(APP_TITLE)
        self.root.geometry("640x360")
        self.root.minsize(560, 300)
        self.root.configure(bg="#0b1020")
        self.server: ThreadingHTTPServer | None = None
        self.server_thread: threading.Thread | None = None
        self.sync_worker: PeriodicSyncWorker | None = None
        self.url = ""
        self.opened_once = False
        self.status = StringVar(value="正在启动泡面侠训练站...")
        self.sync_status = StringVar(value="GitHub 同步尚未配置")
        self.url_var = StringVar(value="")
        self._build_ui()
        self.root.protocol("WM_DELETE_WINDOW", self.close)

    def _build_ui(self) -> None:
        outer = Frame(self.root, bg="#0b1020", padx=22, pady=22)
        outer.pack(fill=BOTH, expand=True)

        Label(
            outer,
            text="MATH QUEST",
            fg="#f5c842",
            bg="#0b1020",
            font=("Consolas", 16, "bold"),
        ).pack(anchor="w")
        Label(
            outer,
            text="泡面侠训练站桌面版",
            fg="#eef2ff",
            bg="#0b1020",
            font=("Microsoft YaHei UI", 22, "bold"),
        ).pack(anchor="w", pady=(10, 8))
        Label(
            outer,
            text="双击后会自动启动本地训练站。配置好 GitHub 私有仓库后，它会在后台把你的提交推给小和，再把回执拉回来。",
            fg="#b7c2d8",
            bg="#0b1020",
            font=("Microsoft YaHei UI", 11),
            wraplength=560,
            justify=LEFT,
        ).pack(anchor="w")

        status_card = Frame(outer, bg="#141c2e", padx=16, pady=16, highlightbackground="#334155", highlightthickness=1)
        status_card.pack(fill=X, pady=(18, 12))
        Label(
            status_card,
            textvariable=self.status,
            fg="#eef2ff",
            bg="#141c2e",
            font=("Microsoft YaHei UI", 11, "bold"),
            wraplength=520,
            justify=LEFT,
        ).pack(anchor="w")
        Label(
            status_card,
            textvariable=self.url_var,
            fg="#00ffcc",
            bg="#141c2e",
            font=("Consolas", 10),
        ).pack(anchor="w", pady=(8, 0))

        sync_card = Frame(outer, bg="#12192c", padx=16, pady=14, highlightbackground="#273248", highlightthickness=1)
        sync_card.pack(fill=X, pady=(0, 14))
        Label(
            sync_card,
            text="GitHub 同步桥",
            fg="#f5c842",
            bg="#12192c",
            font=("Microsoft YaHei UI", 11, "bold"),
        ).pack(anchor="w")
        Label(
            sync_card,
            textvariable=self.sync_status,
            fg="#d8e0f2",
            bg="#12192c",
            font=("Microsoft YaHei UI", 10),
            wraplength=520,
            justify=LEFT,
        ).pack(anchor="w", pady=(8, 0))

        actions = Frame(outer, bg="#0b1020")
        actions.pack(fill=X, side="bottom", pady=(12, 0))

        self.open_button = Button(
            actions,
            text="打开训练站",
            state="disabled",
            command=self.open_browser,
            bg="#f5c842",
            fg="#1f1400",
            activebackground="#ffd166",
            activeforeground="#1f1400",
            relief="flat",
            padx=16,
            pady=10,
            font=("Microsoft YaHei UI", 10, "bold"),
        )
        self.open_button.pack(side=LEFT)

        self.sync_now_button = Button(
            actions,
            text="立即同步",
            command=self.trigger_sync,
            bg="#00d4aa",
            fg="#06261f",
            activebackground="#00ffcc",
            activeforeground="#06261f",
            relief="flat",
            padx=16,
            pady=10,
            font=("Microsoft YaHei UI", 10, "bold"),
        )
        self.sync_now_button.pack(side=LEFT, padx=(10, 0))

        Button(
            actions,
            text="打开同步配置",
            command=self.open_config,
            bg="#23314f",
            fg="#eef2ff",
            activebackground="#2d3d64",
            activeforeground="#eef2ff",
            relief="flat",
            padx=16,
            pady=10,
            font=("Microsoft YaHei UI", 10),
        ).pack(side=RIGHT)

        Button(
            actions,
            text="退出客户端",
            command=self.close,
            bg="#182237",
            fg="#eef2ff",
            activebackground="#24314c",
            activeforeground="#eef2ff",
            relief="flat",
            padx=16,
            pady=10,
            font=("Microsoft YaHei UI", 10),
        ).pack(side=RIGHT, padx=(0, 10))

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
        prefix = "同步异常： " if is_error else ""
        self.root.after(0, lambda: self.sync_status.set(f"{prefix}{message}"))

    def _run_sync_once(self) -> str:
        config = self._load_config()
        if not self._sync_ready(config):
            return f"还没配置好 GitHub 同步。请编辑 {self.config_path.name}，填好 owner / repo / token 并把 enabled 改成 true。"
        return sync_client_once(self._sync_args(config))

    def _setup_sync(self) -> None:
        config = self._load_config()
        if not self._sync_ready(config):
            self.sync_status.set(
                f"还没配置 GitHub 同步。点击“打开同步配置”编辑 {self.config_path.name}，填好后重启客户端或点“立即同步”。"
            )
            return
        self.sync_worker = PeriodicSyncWorker(
            name="github-client-sync",
            interval=int(config.get("interval", 300) or 300),
            sync_once=self._run_sync_once,
            on_status=self._set_sync_status,
            signal_path=self.data_root / "sync-now.flag",
        )
        self.sync_worker.start()
        self.sync_status.set("GitHub 同步已启动，正在后台轮询。")

    def start(self) -> None:
        app = build_math_quest_app(port=0)
        self.server = app.create_server()
        port = self.server.server_address[1]
        self.url = f"http://127.0.0.1:{port}"
        self.url_var.set(self.url)
        self.server_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.server_thread.start()
        self._setup_sync()
        self.root.after(50, self._check_ready)
        self.root.mainloop()

    def _check_ready(self) -> None:
        try:
            wait_for_health(self.url, timeout_seconds=0.2)
            self.status.set("训练站已经准备好了。现在可以直接进入。")
            self.open_button.config(state="normal")
            if not self.opened_once:
                self.opened_once = True
                self.open_browser()
        except Exception:
            self.root.after(150, self._check_ready)

    def trigger_sync(self) -> None:
        config = self._load_config()
        if not self._sync_ready(config):
            self.sync_status.set(
                f"同步配置还没填完。请编辑 {self.config_path.name}，填好 owner / repo / token 并把 enabled 改成 true。"
            )
            return
        if self.sync_worker is None:
            self._setup_sync()
        if self.sync_worker is not None:
            self.sync_status.set("正在手动触发一次同步...")
            self.sync_worker.trigger_now()

    def open_browser(self) -> None:
        if not self.url:
            return
        open_external(self.url)
        self.status.set("训练站已经在浏览器里打开。只要这个客户端还开着，本地服务和 GitHub 同步都会继续运行。")

    def open_config(self) -> None:
        self._load_config()
        open_external(self.config_path)

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
        self.root.destroy()


def smoke_test() -> int:
    app = build_math_quest_app(port=0)
    server = app.create_server()
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{port}"
    try:
        wait_for_health(url, timeout_seconds=5)
        with urllib.request.urlopen(url, timeout=2) as response:
            html = response.read().decode("utf-8")
        if "泡面侠训练站" not in html:
            raise RuntimeError("首页内容不对")
        print(f"smoke-ok {url}")
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
    window = DesktopWindow()
    window.start()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
