from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Callable

import httpx

from .errors import MuninMaintenanceError, MuninSdkError, MuninTransportError
from .maintenance import (
    WRITE_ACTIONS,
    DrainVerdict,
    FileWriteQueue,
    PendingWrite,
    error_code_of,
    in_failure_backoff,
    is_gateway_response,
    is_maintenance_response,
    key_fingerprint,
    maintenance_delay_s,
    retry_after_seconds,
    strip_secrets,
)

CLIENT_VERSION = "0.2.0"


def _sdk_error(data: dict[str, Any], fallback: str) -> MuninSdkError:
    """`error` may be an object or a bare string code (e.g. "ERR_STALE_PROTOCOL")."""
    code = error_code_of(data) or "INTERNAL_ERROR"
    error = data.get("error")
    message = error.get("message", code) if isinstance(error, dict) else str(error or fallback)
    details = error.get("details", {}) if isinstance(error, dict) else {}
    return MuninSdkError(code, message, details)


@dataclass
class MuninClient:
    base_url: str
    api_key: str | None = None
    timeout_s: float = 15.0
    transport: httpx.BaseTransport | None = None
    write_queue: FileWriteQueue | None | bool = True   # True: default file queue; False/None: no queue
    maintenance_retries: int = 2
    maintenance_max_wait_s: float = 5.0
    flush_before_write_s: float = 5.0   # time a call may spend sending older queued writes
    sleep: Callable[[float], None] = time.sleep

    def __post_init__(self) -> None:
        self._http = httpx.Client(transport=self.transport, timeout=self.timeout_s)
        self._queue = FileWriteQueue() if self.write_queue is True else (self.write_queue or None)
        self._flushing = False
        self._dead_lettered = 0

    def take_dead_letter_count(self) -> int:
        """Queued writes this client's flushes dead-lettered since the last call; resets to 0."""
        count, self._dead_lettered = self._dead_lettered, 0
        return count

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    def capabilities(self) -> dict[str, Any]:
        url = f"{self.base_url.rstrip('/')}/api/mcp/capabilities"
        try:
            response = self._http.get(url, headers=self._headers())
        except Exception as exc:  # noqa: BLE001
            raise MuninTransportError(str(exc)) from exc

        body = self._json(response)
        if not response.is_success or not body.get("ok"):
            raise _sdk_error(body, "Failed to fetch capabilities")
        return body.get("data", {})

    def _send(self, project_id: str, action: str, payload: dict[str, Any]) -> httpx.Response:
        url = f"{self.base_url.rstrip('/')}/api/mcp/action"
        body = {"action": action, "project": project_id, "projectId": project_id, "payload": payload,
                "client": {"name": "munin-sdk-py", "version": CLIENT_VERSION}}
        try:
            return self._http.post(url, headers=self._headers(), json=body)
        except Exception as exc:  # noqa: BLE001
            raise MuninTransportError(str(exc)) from exc

    @staticmethod
    def _json(response: httpx.Response) -> dict[str, Any]:
        try:
            data = response.json()
            return data if isinstance(data, dict) else {}
        except ValueError:
            return {}

    def _owned(self, write: PendingWrite) -> bool:
        return write.base_url == self.base_url and write.key_fingerprint == key_fingerprint(self.api_key)

    def _enqueue(self, project_id: str, action: str, payload: dict[str, Any]) -> PendingWrite:
        safe, stripped = strip_secrets(payload)
        write = PendingWrite(self.base_url, key_fingerprint(self.api_key), project_id, action, safe, stripped)
        self._queue.enqueue(write)
        return write

    def _flush_deadline(self) -> float:
        return time.monotonic() + self.flush_before_write_s

    def _flush_before_write(self, project_id: str) -> bool:
        """Send older queued writes first (bounded), so none can land after, and overwrite, this one."""
        self.flush_pending_writes(deadline=self._flush_deadline())
        return not self._queue.has(lambda w: self._owned(w) and w.project_id == project_id)

    def invoke(self, project_id: str, action: str, payload: dict[str, Any]) -> dict[str, Any]:
        is_write = action.lower() in WRITE_ACTIONS
        if is_write and self._queue is not None and not self._flush_before_write(project_id):
            # An older write of this project is still queued: this one goes behind it, never ahead.
            raise MuninMaintenanceError(action, True, None, self._enqueue(project_id, action, payload).id, "pending")

        response = self._send(project_id, action, payload)
        data = self._json(response)
        attempt = 0
        while is_maintenance_response(response.status_code, data) and attempt < self.maintenance_retries:
            wait = retry_after_seconds(response.headers.get("retry-after"), data)
            self.sleep(maintenance_delay_s(attempt, wait, self.maintenance_max_wait_s))
            response = self._send(project_id, action, payload)
            data = self._json(response)
            attempt += 1

        if is_maintenance_response(response.status_code, data):
            retry_after = retry_after_seconds(response.headers.get("retry-after"), data)
            if is_write and self._queue is not None:
                raise MuninMaintenanceError(action, True, retry_after, self._enqueue(project_id, action, payload).id)
            raise MuninMaintenanceError(action, False, retry_after)

        if not response.is_success or data.get("ok") is False:
            raise _sdk_error(data, f"Action '{action}' failed")

        # Munin accepts calls again: send what a maintenance window left behind.
        # Bounded, because this is synchronous and the caller is waiting.
        self.flush_pending_writes(deadline=self._flush_deadline())
        return data

    def flush_pending_writes(self, deadline: float | None = None) -> dict[str, int]:
        """Send queued writes in order; with a time.monotonic() deadline, what is left stays queued."""
        if self._queue is None or self._flushing or self._queue.size() == 0:
            remaining = 0 if self._queue is None else self._queue.size()
            return {"sent": 0, "dead": 0, "expired": 0, "remaining": remaining}
        self._flushing = True

        def send(write: PendingWrite) -> DrainVerdict:
            if not self._owned(write):
                return "keep"
            if deadline is not None and time.monotonic() >= deadline:
                return "stop"
            if in_failure_backoff(write, time.time()):
                return "stop"  # failed recently: wait, uncounted
            # The stored payload is complete: /api/mcp/action ignores payload
            # secrets, so a stripped encryptionKey never stops a replay.
            try:
                response = self._send(write.project_id, write.action, write.payload)
            except MuninTransportError:
                return "stop"  # offline: without limit
            return _replay_verdict(response, self._json(response), write.action)

        try:
            report = self._queue.drain(send)
        finally:
            self._flushing = False
        self._dead_lettered += report["dead"]
        return report


def _is_json_object(response: httpx.Response) -> bool:
    try:
        return isinstance(response.json(), dict)
    except ValueError:
        return False


def _replay_verdict(response: httpx.Response, data: dict[str, Any], action: str) -> DrainVerdict:
    if response.is_success and data.get("ok") is not False:
        return "done"
    if is_maintenance_response(response.status_code, data):
        return "stop"  # waits for the window to end, without limit
    if is_gateway_response(response.status_code, _is_json_object(response)):
        return "stop"  # proxy outage: like offline
    if response.status_code == 404 and action.lower() in ("delete", "delete_memory"):
        return "done"  # already gone
    if response.status_code >= 500 or response.status_code in (408, 429):
        return "fail"  # counted, bounded
    return "dead"
