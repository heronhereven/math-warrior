import base64
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen


API_VERSION = "2022-11-28"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def stable_json_bytes(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sha256_hex(payload: bytes | str) -> str:
    data = payload.encode("utf-8") if isinstance(payload, str) else payload
    return hashlib.sha256(data).hexdigest()


def compact_timestamp(value: str) -> str:
    return (
        value.replace("-", "")
        .replace(":", "")
        .replace("+00:00", "Z")
        .replace("+08:00", "P8")
        .replace(".", "")
    )


def append_sync_log(log_path: Path, level: str, event: str, message: str, **extra: Any) -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    line = {
        "ts": utc_now_iso(),
        "level": level,
        "event": event,
        "message": message,
        "extra": extra,
    }
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(line, ensure_ascii=False) + "\n")


class GitHubRepoClient:
    def __init__(self, owner: str, repo: str, token: str, branch: str = "main") -> None:
        self.owner = owner
        self.repo = repo
        self.token = token
        self.branch = branch

    def _request(self, method: str, path: str, payload: dict[str, Any] | None = None) -> Any:
        url = f"https://api.github.com{path}"
        data = None
        if payload is not None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = Request(url, data=data, method=method)
        request.add_header("Accept", "application/vnd.github+json")
        request.add_header("Authorization", f"Bearer {self.token}")
        request.add_header("X-GitHub-Api-Version", API_VERSION)
        if data is not None:
            request.add_header("Content-Type", "application/json")
        try:
            with urlopen(request, timeout=25) as response:
                raw = response.read()
                return json.loads(raw.decode("utf-8")) if raw else None
        except HTTPError as exc:
            if exc.code == 404:
                return None
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"GitHub API {exc.code}: {detail}") from exc

    def list_tree(self, prefix: str) -> dict[str, str]:
        path = f"/repos/{self.owner}/{self.repo}/git/trees/{quote(self.branch, safe='')}?recursive=1"
        payload = self._request("GET", path) or {}
        items: dict[str, str] = {}
        for item in payload.get("tree", []):
            if item.get("type") != "blob":
                continue
            item_path = item.get("path", "")
            if item_path.startswith(prefix):
                items[item_path] = item.get("sha", "")
        return items

    def get_file(self, remote_path: str) -> tuple[dict[str, Any], str] | tuple[None, None]:
        content, sha = self.get_bytes(remote_path)
        if content is None:
            return None, None
        return json.loads(content.decode("utf-8")), sha

    def get_bytes(self, remote_path: str) -> tuple[bytes, str] | tuple[None, None]:
        query = urlencode({"ref": self.branch})
        path = f"/repos/{self.owner}/{self.repo}/contents/{quote(remote_path, safe='/')}?{query}"
        payload = self._request("GET", path)
        if payload is None:
            return None, None
        if payload.get("encoding") != "base64":
            raise RuntimeError(f"GitHub 返回了无法识别的编码: {remote_path}")
        return base64.b64decode(payload["content"]), payload.get("sha", "")

    def put_bytes(self, remote_path: str, content: bytes, message: str, sha: str | None = None) -> str:
        body = {
            "message": message,
            "branch": self.branch,
            "content": base64.b64encode(content).decode("ascii"),
        }
        if sha:
            body["sha"] = sha
        path = f"/repos/{self.owner}/{self.repo}/contents/{quote(remote_path, safe='/')}"
        payload = self._request("PUT", path, body) or {}
        return payload.get("content", {}).get("sha", "")

    def put_json(self, remote_path: str, data: dict[str, Any], message: str, sha: str | None = None) -> str:
        return self.put_bytes(remote_path, stable_json_bytes(data), message, sha)

    def put_bytes_if_changed(self, remote_path: str, content: bytes, message: str) -> tuple[str, str]:
        existing, sha = self.get_bytes(remote_path)
        if existing == content and sha:
            return "unchanged", sha
        new_sha = self.put_bytes(remote_path, content, message, sha)
        return ("updated" if sha else "created"), new_sha

    def put_json_if_changed(self, remote_path: str, data: dict[str, Any], message: str) -> tuple[str, str]:
        return self.put_bytes_if_changed(remote_path, stable_json_bytes(data), message)
