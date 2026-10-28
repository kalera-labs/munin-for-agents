"""Queue resilience: same semantics as the TS SDK (test/queue-resilience.test.ts)."""
import json
import os
import threading
import time
from dataclasses import asdict, replace
from datetime import datetime, timedelta, timezone

import httpx

from munin_sdk.client import MuninClient
from munin_sdk.errors import MuninMaintenanceError
from munin_sdk.maintenance import (
    DEAD_LETTER_MAX_AGE_S,
    DEAD_LETTER_MAX_BYTES,
    FAILURE_WINDOW_S,
    MAX_FAILED_ATTEMPTS,
    MAX_PENDING_AGE_S,
    FileWriteQueue,
    PendingWrite,
    key_fingerprint,
)

OK = httpx.Response(200, json={"ok": True})
MAINTENANCE = httpx.Response(503, json={"ok": False, "error": "MAINTENANCE_READ_ONLY", "retryAfter": 900})
SERVER_ERROR = httpx.Response(500, json={"ok": False, "error": "INTERNAL_ERROR"})


def iso(delta_s: float = 0.0) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=delta_s)).strftime("%Y-%m-%dT%H:%M:%SZ")


def entry(**overrides) -> PendingWrite:
    base = PendingWrite("http://munin.test", key_fingerprint("key-a"), "p1", "store", {"key": "k", "content": "c"})
    return replace(base, **overrides)


def recording(answer):
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return answer() if callable(answer) else answer

    return httpx.MockTransport(handler), seen


def client(tmp_path, transport) -> MuninClient:
    return MuninClient("http://munin.test", "key-a", transport=transport, write_queue=FileWriteQueue(tmp_path),
                       sleep=lambda _s: None)


def pending(tmp_path) -> list[dict]:
    path = tmp_path / "pending-writes-python.jsonl"
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()] if path.exists() else []


def dead(tmp_path) -> list[dict]:
    path = tmp_path / "pending-writes-python.dead.jsonl"
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()] if path.exists() else []


def test_stripped_secret_is_sent_not_dead_lettered(tmp_path):
    FileWriteQueue(tmp_path).enqueue(entry(stripped_keys=["encryptionKey"]))
    transport, seen = recording(OK)
    report = client(tmp_path, transport).flush_pending_writes()
    assert report["sent"] == 1 and report["dead"] == 0
    assert seen[0]["payload"] == {"key": "k", "content": "c"}


def failed_before(attempts: int, first_failed_s_ago: float) -> dict:
    """An entry whose backoff has run out, so the next pass sends it."""
    return {"failed_attempts": attempts, "first_failed_at": iso(-first_failed_s_ago),
            "last_failed_at": iso(-1), "next_attempt_at": iso(-1)}


def test_failures_are_spaced_by_backoff(tmp_path):
    FileWriteQueue(tmp_path).enqueue(entry())
    transport, seen = recording(SERVER_ERROR)
    c = client(tmp_path, transport)
    for _ in range(MAX_FAILED_ATTEMPTS * 2):
        assert c.flush_pending_writes()["dead"] == 0
    for i in range(MAX_FAILED_ATTEMPTS):
        try:
            c.invoke("p1", "store", {"key": f"new-{i}"})
            raise AssertionError("expected MuninMaintenanceError")
        except MuninMaintenanceError:
            pass
    kept = pending(tmp_path)[0]
    assert kept["payload"]["key"] == "k"
    assert kept["failed_attempts"] == 1, "one failure per backoff interval"
    assert kept["last_failed_at"]
    assert datetime.fromisoformat(kept["next_attempt_at"].replace("Z", "+00:00")) > datetime.now(timezone.utc)
    assert len(seen) == 1, "no request while the backoff runs"
    assert dead(tmp_path) == []


def test_failing_entry_needs_attempts_and_time(tmp_path):
    early, sparse, spent = tmp_path / "early", tmp_path / "sparse", tmp_path / "spent"
    failing, _ = recording(SERVER_ERROR)
    FileWriteQueue(early).enqueue(entry(**failed_before(MAX_FAILED_ATTEMPTS - 1, 60)))
    assert client(early, failing).flush_pending_writes()["dead"] == 0, "attempts alone do not dead-letter"
    assert pending(early)[0]["failed_attempts"] == MAX_FAILED_ATTEMPTS

    FileWriteQueue(sparse).enqueue(entry(**failed_before(1, FAILURE_WINDOW_S + 1)))
    assert client(sparse, failing).flush_pending_writes()["dead"] == 0, "time alone does not dead-letter"

    queue = FileWriteQueue(spent)
    queue.enqueue(entry(**failed_before(MAX_FAILED_ATTEMPTS - 1, FAILURE_WINDOW_S + 1)))
    queue.enqueue(entry(payload={"key": "next"}))
    transport, seen = recording(lambda: SERVER_ERROR if len(seen) == 1 else OK)
    c = client(spent, transport)
    report = c.flush_pending_writes()
    assert report["dead"] == 1 and report["sent"] == 1 and pending(spent) == []
    assert dead(spent)[0]["dead_reason"] == "failed"
    assert c.take_dead_letter_count() == 1


def test_gateway_answers_are_not_counted(tmp_path):
    gateways = [
        httpx.Response(502, text="<html>502 Bad Gateway</html>", headers={"content-type": "text/html"}),
        httpx.Response(504, text="<html>504 Gateway Time-out</html>", headers={"content-type": "text/html"}),
        httpx.Response(520, text="error code: 520"),
        httpx.Response(503, json={"ok": False, "error": "SERVICE_UNAVAILABLE"}),
        httpx.Response(500, text="<html>Internal Server Error</html>", headers={"content-type": "text/html"}),
        httpx.Response(500, text=""),
    ]
    for index, answer in enumerate(gateways):
        directory = tmp_path / str(index)
        FileWriteQueue(directory).enqueue(entry())
        transport, _ = recording(answer)
        c = client(directory, transport)
        for i in range(MAX_FAILED_ATTEMPTS * 2):
            try:
                c.invoke("p1", "store", {"key": f"new-{i}"})
                raise AssertionError("expected MuninMaintenanceError")
            except MuninMaintenanceError:
                pass
        kept = pending(directory)[0]
        assert kept["payload"]["key"] == "k", f"status {answer.status_code}: the freeze write is kept"
        assert kept["failed_attempts"] == 0, f"status {answer.status_code}: not counted"
        assert dead(directory) == [], f"status {answer.status_code}: nothing dead-lettered"


def test_maintenance_and_transport_never_dead_letter(tmp_path):
    FileWriteQueue(tmp_path).enqueue(entry())
    down, _ = recording(MAINTENANCE)

    def unreachable(_request):
        raise httpx.ConnectError("offline")

    for _ in range(MAX_FAILED_ATTEMPTS * 2):
        assert client(tmp_path, down).flush_pending_writes()["dead"] == 0
        assert client(tmp_path, httpx.MockTransport(unreachable)).flush_pending_writes()["dead"] == 0
    assert pending(tmp_path)[0].get("failed_attempts", 0) == 0


def test_write_behind_a_failing_entry_is_not_called_maintenance(tmp_path):
    FileWriteQueue(tmp_path).enqueue(entry())
    transport, _ = recording(SERVER_ERROR)
    try:
        client(tmp_path, transport).invoke("p1", "store", {"key": "new"})
        raise AssertionError("expected MuninMaintenanceError")
    except MuninMaintenanceError as error:
        assert error.queued is True
        assert "in maintenance" not in str(error).lower()
        assert "older" in str(error).lower()


def test_stale_entries_expire(tmp_path):
    queue = FileWriteQueue(tmp_path)
    queue.enqueue(entry(queued_at=iso(-MAX_PENDING_AGE_S - 1)))
    queue.enqueue(entry(queued_at=iso(-MAX_PENDING_AGE_S - 1), key_fingerprint="someone-else"))
    transport, seen = recording(MAINTENANCE)
    report = client(tmp_path, transport).flush_pending_writes()
    assert report["expired"] == 2 and report["dead"] == 2 and seen == []
    assert [d["dead_reason"] for d in dead(tmp_path)] == ["expired", "expired"]


def test_slow_drain_does_not_block_enqueue(tmp_path):
    queue = FileWriteQueue(tmp_path)
    queue.enqueue(entry(payload={"key": "a"}))
    queue.enqueue(entry(payload={"key": "b"}))
    gate, started = threading.Event(), threading.Event()
    sent: list[str] = []

    def slow(request: httpx.Request) -> httpx.Response:
        started.set()
        gate.wait(5)
        sent.append(json.loads(request.content)["payload"]["key"])
        return OK

    result: dict = {}
    worker = threading.Thread(target=lambda: result.update(client(tmp_path, httpx.MockTransport(slow)).flush_pending_writes()))
    worker.start()
    assert started.wait(5)
    t0 = time.monotonic()
    FileWriteQueue(tmp_path).enqueue(entry(payload={"key": "appended"}))
    assert time.monotonic() - t0 < 1.0, "enqueue is not held behind network sends"
    transport, seen = recording(OK)
    assert client(tmp_path, transport).flush_pending_writes()["sent"] == 0 and seen == [], "single drain"
    gate.set()
    worker.join(5)
    assert result["sent"] == 2 and sent == ["a", "b"]
    assert [p["payload"]["key"] for p in pending(tmp_path)] == ["appended"]


def test_dead_letter_file_is_bounded(tmp_path):
    dead_file = tmp_path / "pending-writes-python.dead.jsonl"
    tmp_path.mkdir(exist_ok=True)
    dead_file.write_text(json.dumps({"id": "ancient", "dead_at": iso(-DEAD_LETTER_MAX_AGE_S - 1)}) + "\n"
                         + json.dumps({"id": "older", "dead_at": iso(-60)}) + "\n")
    queue = FileWriteQueue(tmp_path)
    big = "x" * (64 * 1024)
    count = DEAD_LETTER_MAX_BYTES // len(big) + 4
    for i in range(count):
        queue.enqueue(entry(payload={"key": f"k{i}", "content": big}))
    rejected = httpx.Response(400, json={"ok": False, "error": "VALIDATION_ERROR"})
    transport, _ = recording(rejected)
    assert client(tmp_path, transport).flush_pending_writes()["dead"] == count
    assert oct(os.stat(dead_file).st_mode & 0o777) == oct(0o600)
    lines = dead(tmp_path)
    assert all(line.get("id") not in ("ancient", "older") for line in lines), "older lines make room"
    assert [line["payload"]["key"] for line in lines] == [f"k{i}" for i in range(count)], "every new letter is written"
    assert lines[-1]["dead_reason"] == "rejected"

    queue.enqueue(entry(payload={"key": "latest", "content": "small"}))
    transport, _ = recording(rejected)
    client(tmp_path, transport).flush_pending_writes()
    assert dead_file.stat().st_size <= DEAD_LETTER_MAX_BYTES
    kept = dead(tmp_path)
    assert kept[-1]["payload"]["key"] == "latest" and kept[-2]["payload"]["key"] == f"k{count - 1}"


def test_oversized_dead_letter_is_truncated_not_dropped(tmp_path):
    huge = "y" * (DEAD_LETTER_MAX_BYTES * 2)
    FileWriteQueue(tmp_path).enqueue(entry(payload={"key": "huge", "content": huge}))
    transport, _ = recording(httpx.Response(413, json={"ok": False, "error": "PAYLOAD_TOO_LARGE"}))
    assert client(tmp_path, transport).flush_pending_writes()["dead"] == 1
    dead_file = tmp_path / "pending-writes-python.dead.jsonl"
    assert dead_file.stat().st_size <= DEAD_LETTER_MAX_BYTES
    [letter] = dead(tmp_path)
    assert letter["payload"]["key"] == "huge" and letter["truncated"] is True
    assert 0 < len(letter["payload"]["content"]) < len(huge)
    assert letter["dead_reason"] == "rejected" and letter["dead_at"]


def test_old_queue_lines_still_load(tmp_path):
    legacy = {k: v for k, v in asdict(entry()).items()
              if k not in ("failed_attempts", "first_failed_at", "last_failed_at", "next_attempt_at")}
    tmp_path.mkdir(exist_ok=True)
    (tmp_path / "pending-writes-python.jsonl").write_text(json.dumps(legacy) + "\n")
    assert FileWriteQueue(tmp_path).size() == 1
