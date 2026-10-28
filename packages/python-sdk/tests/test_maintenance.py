import json
import stat
import time

import httpx
import pytest

from munin_sdk.client import MuninClient
from munin_sdk.errors import MuninMaintenanceError, MuninSdkError
from munin_sdk.maintenance import FileWriteQueue

MAINTENANCE = httpx.Response(503, headers={"Retry-After": "900"},
                             json={"ok": False, "error": "MAINTENANCE_READ_ONLY", "retryAfter": 900})


def scripted(*responses: httpx.Response):
    script = list(responses)
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return script.pop(0) if len(script) > 1 else script[0]

    return httpx.MockTransport(handler), seen


def make(tmp_path, transport, sleeps=None):
    return MuninClient("http://munin.test", "key-a", transport=transport, write_queue=FileWriteQueue(tmp_path),
                       sleep=(sleeps.append if sleeps is not None else (lambda _s: None)))


def test_write_is_retried_then_queued_without_secrets(tmp_path):
    transport, seen = scripted(MAINTENANCE)
    sleeps: list[float] = []
    with pytest.raises(MuninMaintenanceError) as caught:
        make(tmp_path, transport, sleeps).invoke("p1", "store", {"key": "k", "content": "c", "apiKey": "x"})
    assert caught.value.queued is True
    assert "maintenance" in str(caught.value).lower()
    assert len(seen) == 3 and sleeps == [5.0, 5.0]
    queue_file = tmp_path / "pending-writes-python.jsonl"
    assert stat.S_IMODE(queue_file.stat().st_mode) == 0o600
    assert '"x"' not in queue_file.read_text()


def test_read_is_never_queued(tmp_path):
    transport, _ = scripted(MAINTENANCE)
    with pytest.raises(MuninMaintenanceError) as caught:
        make(tmp_path, transport).invoke("p1", "search", {"query": "q"})
    assert caught.value.queued is False
    assert FileWriteQueue(tmp_path).size() == 0


def test_string_error_no_longer_crashes(tmp_path):
    transport, _ = scripted(httpx.Response(400, json={"ok": False, "error": "ERR_STALE_PROTOCOL"}))
    with pytest.raises(MuninSdkError) as caught:
        make(tmp_path, transport).invoke("p1", "store", {"key": "k"})
    assert caught.value.code == "ERR_STALE_PROTOCOL"


def test_next_success_flushes_the_queue(tmp_path):
    down, _ = scripted(MAINTENANCE)
    with pytest.raises(MuninMaintenanceError):
        make(tmp_path, down).invoke("p1", "store", {"key": "later"})
    up, seen = scripted(httpx.Response(200, json={"ok": True}))
    make(tmp_path, up).invoke("p1", "search", {"query": "q"})
    assert [r["action"] for r in seen] == ["search", "store"]
    assert FileWriteQueue(tmp_path).size() == 0


def test_queued_write_goes_before_a_newer_write(tmp_path):
    down, _ = scripted(MAINTENANCE)
    with pytest.raises(MuninMaintenanceError):
        make(tmp_path, down).invoke("p1", "store", {"key": "k", "content": "old"})
    up, seen = scripted(httpx.Response(200, json={"ok": True}))
    make(tmp_path, up).invoke("p1", "store", {"key": "k", "content": "new"})
    assert [r["payload"]["content"] for r in seen] == ["old", "new"]
    assert FileWriteQueue(tmp_path).size() == 0


def test_new_write_queues_behind_one_it_cannot_flush_in_time(tmp_path):
    down, _ = scripted(MAINTENANCE)
    with pytest.raises(MuninMaintenanceError):
        make(tmp_path, down).invoke("p1", "delete", {"key": "k"})
    up, seen = scripted(httpx.Response(200, json={"ok": True}))
    impatient = MuninClient("http://munin.test", "key-a", transport=up, write_queue=FileWriteQueue(tmp_path),
                            flush_before_write_s=0)
    with pytest.raises(MuninMaintenanceError) as caught:
        impatient.invoke("p1", "store", {"key": "k", "content": "after-delete"})
    assert caught.value.queued is True and seen == []
    impatient.flush_pending_writes()
    assert [r["action"] for r in seen] == ["delete", "store"]


def test_flush_after_a_read_is_bounded(tmp_path):
    down, _ = scripted(MAINTENANCE)
    for i in range(20):
        with pytest.raises(MuninMaintenanceError):
            make(tmp_path, down).invoke("p1", "store", {"key": f"k{i}"})
    seen: list[str] = []

    def slow(request: httpx.Request) -> httpx.Response:
        time.sleep(0.05)
        seen.append(json.loads(request.content)["action"])
        return httpx.Response(200, json={"ok": True})

    reader = MuninClient("http://munin.test", "key-a", transport=httpx.MockTransport(slow),
                         write_queue=FileWriteQueue(tmp_path), flush_before_write_s=0.2)
    started = time.monotonic()
    reader.invoke("p1", "search", {"query": "q"})
    assert time.monotonic() - started < 1.0, "a read never waits for the whole queue"
    assert seen[0] == "search" and 0 < len(seen) - 1 < 20
    assert FileWriteQueue(tmp_path).size() == 20 - (len(seen) - 1)
