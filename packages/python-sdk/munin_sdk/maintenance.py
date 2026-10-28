"""Client side of the Munin write freeze (server MUNIN_READ_ONLY)."""
from __future__ import annotations

import hashlib
import json
import os
import time
import uuid
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, Callable, Literal

MAINTENANCE_ERROR_CODE = "MAINTENANCE_READ_ONLY"
WRITE_ACTIONS = frozenset({
    "store", "store_memory", "store_batch", "share",
    "delete", "delete_memory", "rollback", "acknowledge_setup",
})
SECRET_PAYLOAD_KEYS = ("encryptionKey", "apiKey")
MAX_PENDING_WRITES = 1000
MAX_BYTES = 10 * 1024 * 1024
LOCK_STALE_S = 60
LOCK_WAIT_S = 5
# Applying a finished drain may wait longer: giving up means resending what was sent.
RECONCILE_LOCK_WAIT_S = 30
# An entry is dead-lettered only once it has failed at least MAX_FAILED_ATTEMPTS
# times (not maintenance, not offline, not a gateway) AND its first failure is
# at least FAILURE_WINDOW_S old.
MAX_FAILED_ATTEMPTS = 5
FAILURE_WINDOW_S = 30 * 60
# Wait after the first failure before the entry is sent again; doubles per failure.
FAILURE_BACKOFF_BASE_S = 30
FAILURE_BACKOFF_MAX_S = 5 * 60
# A queued write older than this is never replayed: it could overwrite newer edits.
MAX_PENDING_AGE_S = 24 * 60 * 60
# Dead letters are pruned by age and the file keeps its newest lines within a byte budget.
DEAD_LETTER_MAX_AGE_S = 7 * 24 * 60 * 60
DEAD_LETTER_MAX_BYTES = 1024 * 1024

# done: sent · dead: rejected for good · keep: not ours · stop: maintenance,
# offline, a gateway answer, in its failure backoff or out of time (keeps it and
# every later entry) · fail: other server failure, counted on the entry and
# backed off, dead-lettered once the budget is spent.
DrainVerdict = Literal["done", "dead", "keep", "stop", "fail"]


def error_code_of(body: Any) -> str:
    if not isinstance(body, dict):
        return ""
    error = body.get("error")
    if isinstance(error, str):
        return error
    if isinstance(error, dict) and isinstance(error.get("code"), str):
        return error["code"]
    return ""


def is_maintenance_response(status: int, body: Any) -> bool:
    return status == 503 and error_code_of(body) == MAINTENANCE_ERROR_CODE


def is_gateway_response(status: int, json_body: bool) -> bool:
    """A proxy answering for a Munin that is restarting or unreachable (502, 503
    without MAINTENANCE_READ_ONLY, 504, 52x), or any 5xx whose body is not a JSON
    object (Munin always answers JSON). Treated like a transport error."""
    if status < 500:
        return False
    if not json_body:
        return True
    return status in (502, 503, 504) or 520 <= status <= 529


def retry_after_seconds(header: str | None, body: Any) -> float | None:
    if header:
        try:
            return max(0.0, float(header))
        except ValueError:
            try:
                return max(0.0, parsedate_to_datetime(header).timestamp() - time.time())
            except (TypeError, ValueError):
                pass
    value = body.get("retryAfter") if isinstance(body, dict) else None
    return float(value) if isinstance(value, (int, float)) and value >= 0 else None


def maintenance_delay_s(attempt: int, retry_after: float | None, max_wait_s: float) -> float:
    return min(max(2.0 ** attempt, retry_after or 0.0), max_wait_s)


def strip_secrets(payload: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    stripped = [k for k in SECRET_PAYLOAD_KEYS if k in payload]
    return {k: v for k, v in payload.items() if k not in SECRET_PAYLOAD_KEYS}, stripped


def key_fingerprint(api_key: str | None) -> str:
    return hashlib.sha256(api_key.encode()).hexdigest()[:16] if api_key else "anonymous"


@dataclass(frozen=True)
class PendingWrite:
    base_url: str
    key_fingerprint: str
    project_id: str
    action: str
    payload: dict[str, Any]
    stripped_keys: list[str] = field(default_factory=list)
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    queued_at: str = field(default_factory=lambda: _iso(time.time()))
    failed_attempts: int = 0
    first_failed_at: str | None = None
    last_failed_at: str | None = None
    # Not sent again before this time: a burst of calls counts one failure, not one per call.
    next_attempt_at: str | None = None


def _iso(epoch_s: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch_s))


def _parse_iso(value: Any) -> float | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return (parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)).timestamp()


def is_expired(write: PendingWrite, now: float) -> bool:
    queued_at = _parse_iso(write.queued_at)
    return queued_at is None or now - queued_at > MAX_PENDING_AGE_S


def failure_backoff_s(failed_attempts: int) -> float:
    """Backoff after the n-th failure (n >= 1)."""
    return min(FAILURE_BACKOFF_BASE_S * 2 ** max(0, failed_attempts - 1), FAILURE_BACKOFF_MAX_S)


def record_failure(write: PendingWrite, now: float) -> PendingWrite:
    attempts = write.failed_attempts + 1
    return replace(write, failed_attempts=attempts, first_failed_at=write.first_failed_at or _iso(now),
                   last_failed_at=_iso(now), next_attempt_at=_iso(now + failure_backoff_s(attempts)))


def in_failure_backoff(write: PendingWrite, now: float) -> bool:
    """Still waiting out the backoff of its last failure: not sent, not counted."""
    next_attempt = _parse_iso(write.next_attempt_at)
    return next_attempt is not None and now < next_attempt


def failure_budget_spent(write: PendingWrite, now: float) -> bool:
    if write.failed_attempts < MAX_FAILED_ATTEMPTS:
        return False
    first = _parse_iso(write.first_failed_at)
    return first is not None and now - first >= FAILURE_WINDOW_S


def _dead_letter(write: PendingWrite, reason: str, now: float) -> dict[str, Any]:
    return {**asdict(write), "dead_at": _iso(now), "dead_reason": reason}


@dataclass(frozen=True)
class DrainOutcome:
    sent: int
    removed: frozenset[str]
    updated: dict[str, PendingWrite]
    dead: list[dict[str, Any]]
    expired: int


def drain_entries(
    entries: list[PendingWrite],
    send: Callable[[PendingWrite], DrainVerdict],
    after_each: Callable[[], None] = lambda: None,
    now: Callable[[], float] = time.time,
) -> DrainOutcome:
    """One drain pass; mirrors drainEntries in the TS SDK."""
    removed: set[str] = set()
    updated: dict[str, PendingWrite] = {}
    dead: list[dict[str, Any]] = []
    sent = expired = 0
    stopped = False
    for entry in entries:
        if is_expired(entry, now()):
            removed.add(entry.id)
            dead.append(_dead_letter(entry, "expired", now()))
            expired += 1
            continue
        if stopped:
            continue
        verdict = send(entry)
        after_each()
        if verdict == "done":
            removed.add(entry.id)
            sent += 1
        elif verdict == "dead":
            removed.add(entry.id)
            dead.append(_dead_letter(entry, "rejected", now()))
        elif verdict == "fail":
            failed = record_failure(entry, now())
            if failure_budget_spent(failed, now()):
                removed.add(entry.id)
                dead.append(_dead_letter(failed, "failed", now()))
            else:
                updated[entry.id] = failed
                stopped = True
        elif verdict == "stop":
            stopped = True
    return DrainOutcome(sent, frozenset(removed), updated, dead, expired)


def apply_outcome(current: list[PendingWrite], outcome: DrainOutcome) -> list[PendingWrite]:
    """The queue after a pass: entries appended while it ran are kept, in order."""
    return [outcome.updated.get(e.id, e) for e in current if e.id not in outcome.removed]


def _line_bytes(line: str) -> int:
    return len(line.encode("utf8")) + 1  # with its newline


def _is_young(line: str, now: float) -> bool:
    try:
        dead_at = _parse_iso(json.loads(line).get("dead_at"))
    except (ValueError, AttributeError):
        return False
    return dead_at is not None and now - dead_at <= DEAD_LETTER_MAX_AGE_S


def _shrink_strategies(letter: dict[str, Any]) -> list[tuple[str, Callable[[str], str]]]:
    """Ways to shrink an oversized letter, in order: the text to cut and the line rebuilt around a cut."""
    if "malformed" in letter:
        return [(str(letter["malformed"]), lambda cut: json.dumps({**letter, "malformed": cut, "truncated": True}))]
    payload = letter.get("payload") if isinstance(letter.get("payload"), dict) else {}
    strategies: list[tuple[str, Callable[[str], str]]] = []
    if isinstance(payload.get("content"), str):
        strategies.append((payload["content"], lambda cut: json.dumps(
            {**letter, "payload": {**payload, "content": cut}, "truncated": True})))
    strategies.append((json.dumps(payload), lambda cut: json.dumps(
        {**letter, "payload": {"truncated_payload": cut}, "truncated": True})))
    return strategies


def fit_dead_letter(letter: dict[str, Any]) -> str:
    """The letter as one JSON line within DEAD_LETTER_MAX_BYTES: an oversized one keeps
    the longest prefix of its payload content (or whole payload, or malformed line)
    that fits, marked truncated: true. Mirrors fitDeadLetter in the TS SDK."""
    line = json.dumps(letter)
    if _line_bytes(line) <= DEAD_LETTER_MAX_BYTES:
        return line
    for text, rebuild in _shrink_strategies(letter):
        best = rebuild("")
        if _line_bytes(best) > DEAD_LETTER_MAX_BYTES:
            continue
        lo, hi = 0, min(len(text), DEAD_LETTER_MAX_BYTES)
        while lo <= hi:
            mid = (lo + hi) // 2
            candidate = rebuild(text[:mid])
            if _line_bytes(candidate) <= DEAD_LETTER_MAX_BYTES:
                best, lo = candidate, mid + 1
            else:
                hi = mid - 1
        return best
    keep = ("id", "project_id", "action", "dead_at", "dead_reason")
    return json.dumps({**{k: letter[k] for k in keep if k in letter}, "truncated": True})


def bound_dead_letters(existing: list[str], added: list[str], now: float) -> list[str]:
    """The dead-letter file after adding `added` (lines from fit_dead_letter): every added
    line is kept, so a letter the user is told about is always there; older lines are
    pruned by age, then newest first within what is left of DEAD_LETTER_MAX_BYTES."""
    budget = DEAD_LETTER_MAX_BYTES - sum(_line_bytes(line) for line in added)
    kept: list[str] = []
    for line in reversed(existing):
        if not _is_young(line, now):
            continue
        budget -= _line_bytes(line)
        if budget < 0:
            break
        kept.append(line)
    return list(reversed(kept)) + list(added)


class WriteQueueFullError(Exception):
    pass


class FileWriteQueue:
    """~/.munin/pending-writes-python.jsonl (MUNIN_QUEUE_DIR overrides), 0700 dir, 0600 files.

    The queue lock guards every read-modify-write and is never held across a
    network request. The drain lock lets one process at a time send: a drain
    claims a snapshot under the queue lock, sends holding only the drain lock,
    then applies the outcome under the queue lock, keeping writes appended
    meanwhile.
    """

    def __init__(self, directory: str | os.PathLike[str] | None = None) -> None:
        self.dir = Path(directory or os.environ.get("MUNIN_QUEUE_DIR") or Path.home() / ".munin")
        self.pending = self.dir / "pending-writes-python.jsonl"
        self.dead = self.dir / "pending-writes-python.dead.jsonl"
        self.lock = self.dir / "pending-writes-python.lock"
        self.drain_lock = self.dir / "pending-writes-python.drain.lock"

    def _acquire(self, lock: Path, wait_s: float = LOCK_WAIT_S) -> bool:
        self.dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.dir, 0o700)
        deadline = time.monotonic() + wait_s
        while True:
            try:
                os.close(os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600))
                return True
            except FileExistsError:
                try:
                    if time.time() - lock.stat().st_mtime > LOCK_STALE_S:
                        lock.unlink(missing_ok=True)
                        continue
                except FileNotFoundError:
                    continue
                if time.monotonic() >= deadline:
                    return False
                time.sleep(0.05)

    @staticmethod
    def _release(lock: Path) -> None:
        lock.unlink(missing_ok=True)

    @staticmethod
    def _touch(lock: Path) -> None:
        try:
            os.utime(lock)
        except FileNotFoundError:
            pass

    def _read(self) -> tuple[list[PendingWrite], list[str]]:
        entries: list[PendingWrite] = []
        malformed: list[str] = []
        if not self.pending.exists():
            return entries, malformed
        for line in self.pending.read_text("utf8").splitlines():
            if not line.strip():
                continue
            try:
                entries.append(PendingWrite(**json.loads(line)))
            except (ValueError, TypeError):
                malformed.append(line)
        return entries, malformed

    def _append(self, path: Path, lines: list[str]) -> None:
        if not lines:
            return
        fd = os.open(path, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
        try:
            os.write(fd, "".join(lines).encode("utf8"))
            os.fsync(fd)
        finally:
            os.close(fd)

    def _write_atomic(self, path: Path, lines: list[str]) -> None:
        tmp = path.with_suffix(f".{os.getpid()}.tmp")
        fd = os.open(tmp, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w", encoding="utf8") as handle:
            handle.writelines(line + "\n" for line in lines)
        os.replace(tmp, path)

    def _add_dead_letters(self, letters: list[dict[str, Any]], now: float) -> None:
        """Under the queue lock."""
        if not letters:
            return
        existing = [line for line in self.dead.read_text("utf8").splitlines() if line.strip()] if self.dead.exists() else []
        self._write_atomic(self.dead, bound_dead_letters(existing, [fit_dead_letter(letter) for letter in letters], now))

    def enqueue(self, write: PendingWrite) -> None:
        line = json.dumps(asdict(write)) + "\n"
        if not self._acquire(self.lock):
            raise RuntimeError("Munin local write queue is busy; the write was NOT saved")
        try:
            size = self.pending.stat().st_size if self.pending.exists() else 0
            if size + len(line.encode()) > MAX_BYTES or len(self._read()[0]) >= MAX_PENDING_WRITES:
                raise WriteQueueFullError("Munin local write queue is full; the write was NOT saved")
            self._append(self.pending, [line])
        finally:
            self._release(self.lock)

    def _empty_report(self) -> dict[str, int]:
        return {"sent": 0, "dead": 0, "expired": 0, "remaining": self.size()}

    def drain(self, send: Callable[[PendingWrite], DrainVerdict]) -> dict[str, int]:
        if not self._acquire(self.drain_lock, 0):
            return self._empty_report()  # another process is draining right now
        try:
            if not self._acquire(self.lock):
                return self._empty_report()
            try:
                snapshot = self._read()[0]
            finally:
                self._release(self.lock)
            outcome = drain_entries(snapshot, send, lambda: self._touch(self.drain_lock))
            if not self._acquire(self.lock, RECONCILE_LOCK_WAIT_S):
                raise RuntimeError("Munin local write queue stayed busy; sent writes may be sent again")
            try:
                return self._apply(outcome)
            finally:
                self._release(self.lock)
        finally:
            self._release(self.drain_lock)

    def _apply(self, outcome: DrainOutcome) -> dict[str, int]:
        """Under the queue lock."""
        now = time.time()
        entries, malformed = self._read()
        remaining = apply_outcome(entries, outcome)
        letters = list(outcome.dead) + [
            {"malformed": raw, "dead_at": _iso(now), "dead_reason": "malformed"} for raw in malformed
        ]
        self._add_dead_letters(letters, now)
        self._write_atomic(self.pending, [json.dumps(asdict(e)) for e in remaining])
        return {"sent": outcome.sent, "dead": len(outcome.dead) + len(malformed), "expired": outcome.expired,
                "remaining": len(remaining)}

    def size(self) -> int:
        return len(self._read()[0])

    def has(self, match: Callable[[PendingWrite], bool]) -> bool:
        """No lock: appends happen under the lock and rewrites are an atomic replace."""
        return any(match(entry) for entry in self._read()[0])
