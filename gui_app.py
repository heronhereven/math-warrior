import argparse
import sys
import threading
import urllib.request
import webbrowser
from http.server import ThreadingHTTPServer
from pathlib import Path
from tkinter import BOTH, LEFT, RIGHT, X, Button, Frame, Label, StringVar, Tk

from server import MathQuestApp


APP_TITLE = "Math Quest Desktop"


def resource_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS"))
    return Path(__file__).resolve().parent


def writable_root() -> Path:
    base = Path.home()
    local = Path.home()
    if sys.platform.startswith("win"):
        import os

        local = Path(os.getenv("LOCALAPPDATA") or os.getenv("APPDATA") or base)
    root = local / "MathQuestDesktop"
    root.mkdir(parents=True, exist_ok=True)
    return root


def build_math_quest_app(port: int = 0) -> MathQuestApp:
    data_root = writable_root()
    return MathQuestApp(
        db_path=data_root / "math-quest.db",
        static_dir=resource_root(),
        upload_dir=data_root / "uploads",
        admin_username="admin",
        admin_password="admin123456",
        host="127.0.0.1",
        port=port,
    )


def wait_for_health(url: str, timeout_seconds: float = 8.0) -> None:
    deadline = threading.Event()
    end_time = timeout_seconds
    import time

    started = time.time()
    while time.time() - started < end_time:
        try:
            with urllib.request.urlopen(f"{url}/api/health", timeout=1.5) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(0.15)
    deadline.set()
    raise RuntimeError("本地服务启动超时")


class DesktopWindow:
    def __init__(self) -> None:
        self.root = Tk()
        self.root.title(APP_TITLE)
        self.root.geometry("520x280")
        self.root.minsize(460, 240)
        self.root.configure(bg="#0b1020")
        self.server: ThreadingHTTPServer | None = None
        self.server_thread: threading.Thread | None = None
        self.url = ""
        self.opened_once = False
        self.status = StringVar(value="正在启动泡面侠训练站...")
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
            text="双击这个客户端就会在本机启动后端，然后自动打开训练站页面。",
            fg="#b7c2d8",
            bg="#0b1020",
            font=("Microsoft YaHei UI", 11),
            wraplength=460,
            justify=LEFT,
        ).pack(anchor="w")

        status_card = Frame(outer, bg="#141c2e", padx=16, pady=16, highlightbackground="#334155", highlightthickness=1)
        status_card.pack(fill=X, pady=(18, 14))
        Label(
            status_card,
            textvariable=self.status,
            fg="#eef2ff",
            bg="#141c2e",
            font=("Microsoft YaHei UI", 11, "bold"),
            wraplength=430,
            justify=LEFT,
        ).pack(anchor="w")
        Label(
            status_card,
            textvariable=self.url_var,
            fg="#00ffcc",
            bg="#141c2e",
            font=("Consolas", 10),
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
            padx=18,
            pady=10,
            font=("Microsoft YaHei UI", 10, "bold"),
        )
        self.open_button.pack(side=LEFT)

        Button(
            actions,
            text="退出客户端",
            command=self.close,
            bg="#23314f",
            fg="#eef2ff",
            activebackground="#2d3d64",
            activeforeground="#eef2ff",
            relief="flat",
            padx=18,
            pady=10,
            font=("Microsoft YaHei UI", 10),
        ).pack(side=RIGHT)

    def start(self) -> None:
        app = build_math_quest_app(port=0)
        self.server = app.create_server()
        port = self.server.server_address[1]
        self.url = f"http://127.0.0.1:{port}"
        self.url_var.set(self.url)
        self.server_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.server_thread.start()
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

    def open_browser(self) -> None:
        if not self.url:
            return
        webbrowser.open(self.url)
        self.status.set("训练站已经在浏览器里打开。只要这个客户端还开着，数据就会持续保存。")

    def close(self) -> None:
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
    parser = argparse.ArgumentParser(description="Math Quest 桌面启动器")
    parser.add_argument("--smoke-test", action="store_true", help="仅做一次启动自检")
    args = parser.parse_args()
    if args.smoke_test:
      return smoke_test()
    window = DesktopWindow()
    window.start()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
