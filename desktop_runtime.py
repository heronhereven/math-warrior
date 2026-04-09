import json
import os
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path
from typing import Any, Callable


def resource_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS"))
    return Path(__file__).resolve().parent


def app_data_root(name: str) -> Path:
    candidates: list[Path] = []
    home = Path.home()
    if sys.platform.startswith("win"):
        candidates.extend(
            [
                Path(os.getenv("LOCALAPPDATA") or ""),
                Path(os.getenv("APPDATA") or ""),
                home,
            ]
        )
    else:
        candidates.extend([home / ".local" / "share", home])
    candidates.append(resource_root())

    last_error: Exception | None = None
    for base in candidates:
        if not str(base):
            continue
        try:
            root = base / name
            root.mkdir(parents=True, exist_ok=True)
            return root
        except Exception as exc:
            last_error = exc
            continue
    if last_error is not None:
        raise last_error
    raise RuntimeError("无法创建应用数据目录")


def wait_for_health(url: str, timeout_seconds: float = 8.0) -> None:
    started = time.time()
    while time.time() - started < timeout_seconds:
        try:
            with urllib.request.urlopen(f"{url}/api/health", timeout=1.5) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(0.15)
    raise RuntimeError("本地服务启动超时")


def open_external(target: str | Path) -> None:
    if isinstance(target, Path):
        path = target.resolve()
        if sys.platform.startswith("win"):
            os.startfile(str(path))
        else:
            webbrowser.open(path.as_uri())
        return
    webbrowser.open(str(target))


def ensure_json_template(path: Path, template: dict[str, Any]) -> dict[str, Any]:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_text(json.dumps(template, ensure_ascii=False, indent=2), encoding="utf-8")
        return template.copy()
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        path.write_text(json.dumps(template, ensure_ascii=False, indent=2), encoding="utf-8")
        return template.copy()


class PeriodicSyncWorker:
    def __init__(
        self,
        *,
        name: str,
        interval: int,
        sync_once: Callable[[], str | None],
        on_status: Callable[[str, bool], None],
        signal_path: Path | None = None,
    ) -> None:
        self.name = name
        self.interval = max(30, int(interval))
        self.sync_once = sync_once
        self.on_status = on_status
        self.signal_path = signal_path
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self._pending = False
        self._last_run_started = 0.0
        self._last_signal_seen = self._signal_mtime()

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._run, daemon=True, name=self.name)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=3)
            self._thread = None

    def trigger_now(self) -> None:
        self._pending = True

    def signal_now(self) -> None:
        self.trigger_now()

    def _signal_mtime(self) -> float:
        if self.signal_path is None:
            return 0.0
        try:
            return self.signal_path.stat().st_mtime
        except FileNotFoundError:
            return 0.0

    def _run_once(self) -> None:
        if not self._lock.acquire(blocking=False):
            self._pending = True
            return
        try:
            self._pending = False
            self._last_run_started = time.time()
            message = self.sync_once() or "同步完成"
            self.on_status(message, False)
        except Exception as exc:
            self.on_status(f"同步失败：{exc}", True)
        finally:
            self._lock.release()

    def _run(self) -> None:
        last_periodic = 0.0
        while not self._stop.is_set():
            now = time.time()
            signal_changed = False
            if self.signal_path is not None:
                current_signal = self._signal_mtime()
                if current_signal > self._last_signal_seen:
                    self._last_signal_seen = current_signal
                    signal_changed = True
            if signal_changed:
                self._pending = True
            if self._pending or (now - last_periodic) >= self.interval:
                self._run_once()
                last_periodic = time.time()
            if self._stop.wait(0.8):
                break
