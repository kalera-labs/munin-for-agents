/** A write refused by a maintenance window, kept until Munin accepts writes again. */
export interface PendingWrite {
  id: string;
  queuedAt: string;
  baseUrl: string;
  keyFingerprint: string;
  projectId: string;
  action: string;
  /** Without SECRET_PAYLOAD_KEYS; `strippedKeys` says which ones a rehydrator may re-add. */
  payload: Record<string, unknown>;
  strippedKeys: string[];
  /** Replays that failed with something other than maintenance, a gateway or a transport error. */
  failedAttempts?: number;
  firstFailedAt?: string;
  lastFailedAt?: string;
  /** Not sent again before this time: a burst of calls counts one failure, not one per call. */
  nextAttemptAt?: string;
}

/**
 * done: sent, drop it · dead: the server rejected it for good, dead-letter it ·
 * keep: not ours (another key or server), leave it · stop: still in
 * maintenance, offline, a gateway answer, in its failure backoff or out of
 * time; keep it and every later entry (order is preserved) · fail: any other
 * server failure (5xx, 429); counted on the entry and backed off, dead-lettered
 * once the failure budget is spent, otherwise it stops the pass like `stop`.
 */
export type DrainVerdict = "done" | "dead" | "keep" | "stop" | "fail";

export type DeadReason = "rejected" | "failed" | "expired";

export type DeadLetter = PendingWrite & { deadAt: string; deadReason: DeadReason };

export interface DrainReport {
  sent: number;
  /** Every entry moved to the dead letters, expired ones included. */
  dead: number;
  /** Dead-lettered because they were queued more than MAX_PENDING_AGE_MS ago. */
  expired: number;
  remaining: number;
}

export interface PendingWriteQueue {
  enqueue(write: PendingWrite): Promise<void>;
  drain(send: (write: PendingWrite) => Promise<DrainVerdict>): Promise<DrainReport>;
  size(): Promise<number>;
  /** Whether any pending write (including one a drain is sending right now) matches. */
  has(match: (write: PendingWrite) => boolean): Promise<boolean>;
}

export const MAX_PENDING_WRITES = 1_000;
/**
 * An entry is dead-lettered only once it has failed at least MAX_FAILED_ATTEMPTS
 * times (not maintenance, not offline, not a gateway) AND its first failure is
 * at least FAILURE_WINDOW_MS old.
 */
export const MAX_FAILED_ATTEMPTS = 5;
export const FAILURE_WINDOW_MS = 30 * 60_000;
/** Wait after the first failure before the entry is sent again; doubles per failure. */
export const FAILURE_BACKOFF_BASE_MS = 30_000;
export const FAILURE_BACKOFF_MAX_MS = 5 * 60_000;
/** A queued write older than this is never replayed: it could overwrite newer edits. */
export const MAX_PENDING_AGE_MS = 24 * 60 * 60_000;

export const EMPTY_DRAIN_REPORT: DrainReport = { sent: 0, dead: 0, expired: 0, remaining: 0 };

export class WriteQueueFullError extends Error {
  constructor() {
    super("Munin local write queue is full; the write was NOT saved");
    this.name = "WriteQueueFullError";
  }
}

/** What one drain pass did, by entry id, so a queue can apply it to entries appended meanwhile. */
export interface DrainOutcome {
  sent: number;
  /** Ids to drop: sent or dead-lettered. */
  removed: ReadonlySet<string>;
  /** Entries whose failure count changed. */
  updated: ReadonlyMap<string, PendingWrite>;
  dead: DeadLetter[];
  expired: number;
}

export function isExpired(write: PendingWrite, now: number): boolean {
  const queuedAt = Date.parse(write.queuedAt);
  return !Number.isFinite(queuedAt) || now - queuedAt > MAX_PENDING_AGE_MS;
}

/** Backoff after the n-th failure (n >= 1). */
export function failureBackoffMs(failedAttempts: number): number {
  return Math.min(FAILURE_BACKOFF_BASE_MS * 2 ** Math.max(0, failedAttempts - 1), FAILURE_BACKOFF_MAX_MS);
}

export function recordFailure(write: PendingWrite, now: number): PendingWrite {
  const failedAttempts = (write.failedAttempts ?? 0) + 1;
  return {
    ...write,
    failedAttempts,
    firstFailedAt: write.firstFailedAt ?? new Date(now).toISOString(),
    lastFailedAt: new Date(now).toISOString(),
    nextAttemptAt: new Date(now + failureBackoffMs(failedAttempts)).toISOString(),
  };
}

/** Whether the entry is still waiting out the backoff of its last failure: not sent, not counted. */
export function inFailureBackoff(write: PendingWrite, now: number): boolean {
  const next = write.nextAttemptAt ? Date.parse(write.nextAttemptAt) : NaN;
  return Number.isFinite(next) && now < next;
}

export function failureBudgetSpent(write: PendingWrite, now: number): boolean {
  if ((write.failedAttempts ?? 0) < MAX_FAILED_ATTEMPTS) return false;
  const first = write.firstFailedAt ? Date.parse(write.firstFailedAt) : NaN;
  return Number.isFinite(first) && now - first >= FAILURE_WINDOW_MS;
}

function deadLetter(write: PendingWrite, reason: DeadReason, now: number): DeadLetter {
  return { ...write, deadAt: new Date(now).toISOString(), deadReason: reason };
}

export interface DrainOptions {
  /** Called after every send (a file queue keeps its drain lock fresh). */
  afterEach?: () => Promise<void>;
  now?: () => number;
}

/** One drain pass, shared by every implementation so they agree on order and verdicts. */
export async function drainEntries(
  entries: readonly PendingWrite[],
  send: (write: PendingWrite) => Promise<DrainVerdict>,
  options: DrainOptions = {},
): Promise<DrainOutcome> {
  const now = options.now ?? Date.now;
  const removed = new Set<string>();
  const updated = new Map<string, PendingWrite>();
  const dead: DeadLetter[] = [];
  let sent = 0;
  let expired = 0;
  let stopped = false;
  for (const entry of entries) {
    if (isExpired(entry, now())) {
      removed.add(entry.id);
      dead.push(deadLetter(entry, "expired", now()));
      expired += 1;
      continue;
    }
    if (stopped) continue;
    const verdict = await send(entry);
    await options.afterEach?.();
    if (verdict === "done") {
      removed.add(entry.id);
      sent += 1;
    } else if (verdict === "dead") {
      removed.add(entry.id);
      dead.push(deadLetter(entry, "rejected", now()));
    } else if (verdict === "fail") {
      const failed = recordFailure(entry, now());
      if (failureBudgetSpent(failed, now())) {
        removed.add(entry.id);
        dead.push(deadLetter(failed, "failed", now()));
      } else {
        updated.set(entry.id, failed);
        stopped = true;
      }
    } else if (verdict === "stop") {
      stopped = true;
    }
  }
  return { sent, removed, updated, dead, expired };
}

/** The queue after a pass: entries appended while it ran are kept, in order. */
export function applyOutcome(current: readonly PendingWrite[], outcome: DrainOutcome): PendingWrite[] {
  return current.filter((e) => !outcome.removed.has(e.id)).map((e) => outcome.updated.get(e.id) ?? e);
}

export function reportOf(outcome: DrainOutcome, remaining: number): DrainReport {
  return { sent: outcome.sent, dead: outcome.dead.length, expired: outcome.expired, remaining };
}

/** In-process queue: tests, browsers, or callers that persist elsewhere. */
export class MemoryWriteQueue implements PendingWriteQueue {
  private entries: PendingWrite[] = [];
  private draining = false;
  readonly deadLetters: DeadLetter[] = [];

  async enqueue(write: PendingWrite): Promise<void> {
    if (this.entries.length >= MAX_PENDING_WRITES) throw new WriteQueueFullError();
    this.entries = [...this.entries, write];
  }

  async drain(send: (write: PendingWrite) => Promise<DrainVerdict>): Promise<DrainReport> {
    if (this.draining) return { ...EMPTY_DRAIN_REPORT, remaining: this.entries.length };
    this.draining = true;
    try {
      // Entries stay queued while they are sent, so has() sees them.
      const outcome = await drainEntries(this.entries, send);
      this.entries = applyOutcome(this.entries, outcome);
      this.deadLetters.push(...outcome.dead);
      return reportOf(outcome, this.entries.length);
    } finally {
      this.draining = false;
    }
  }

  async size(): Promise<number> {
    return this.entries.length;
  }

  async has(match: (write: PendingWrite) => boolean): Promise<boolean> {
    return this.entries.some(match);
  }
}
