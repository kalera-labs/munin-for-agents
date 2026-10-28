/**
 * File-backed PendingWriteQueue for Node: ~/.munin/pending-writes.jsonl
 * (MUNIN_QUEUE_DIR overrides). Shared by every Munin process of the user (one
 * MCP server per Claude Code session). Two lock files, both created with
 * O_EXCL:
 * - the queue lock guards every read-modify-write of the files and is only
 *   ever held for local file work, never across a network request;
 * - the drain lock makes one process at a time send queued writes. A drain
 *   claims a snapshot under the queue lock, sends it holding only the drain
 *   lock, then applies the outcome under the queue lock again, so writes
 *   appended meanwhile are kept, in order.
 * The directory is 0700 and the files 0600: a queued memory can be private
 * content. Dead letters are capped by age and size; the letters a call adds
 * are always written (truncated if one alone exceeds the size cap).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  EMPTY_DRAIN_REPORT,
  MAX_PENDING_WRITES,
  WriteQueueFullError,
  applyOutcome,
  drainEntries,
  reportOf,
  type DeadLetter,
  type DrainReport,
  type DrainVerdict,
  type PendingWrite,
  type PendingWriteQueue,
} from "../writeQueue.js";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const MAX_BYTES = 10 * 1024 * 1024;
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 5_000;
/** Applying a finished drain may wait longer: giving up means resending what was sent. */
const RECONCILE_LOCK_WAIT_MS = 30_000;
const LOCK_POLL_MS = 50;
const PENDING = "pending-writes.jsonl";
const DEAD = "pending-writes.dead.jsonl";
const LOCK = "pending-writes.lock";
const DRAIN_LOCK = "pending-writes.drain.lock";

/** Dead letters older than this are pruned whenever new ones are written. */
export const DEAD_LETTER_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** The dead-letter file keeps its newest lines within this many bytes. */
export const DEAD_LETTER_MAX_BYTES = 1024 * 1024;

type MalformedLetter = { malformed: string; deadAt: string; deadReason: "malformed" };

export function defaultQueueDir(): string {
  return process.env.MUNIN_QUEUE_DIR || path.join(os.homedir(), ".munin");
}

interface HeldLock {
  touch(): Promise<void>;
  release(): Promise<void>;
}

type Letter = DeadLetter | MalformedLetter;

function lineBytes(line: string): number {
  return Buffer.byteLength(line) + 1; // with its newline
}

function isYoung(line: string, now: number): boolean {
  try {
    const deadAt = Date.parse(String((JSON.parse(line) as { deadAt?: unknown }).deadAt));
    return Number.isFinite(deadAt) && now - deadAt <= DEAD_LETTER_MAX_AGE_MS;
  } catch {
    return false;
  }
}

/** Ways to shrink an oversized letter, tried in order: the text to cut and the line rebuilt around a cut. */
function shrinkStrategies(letter: Letter): Array<[string, (cut: string) => string]> {
  if ("malformed" in letter) {
    return [[letter.malformed, (cut) => JSON.stringify({ ...letter, malformed: cut, truncated: true })]];
  }
  const payload: Record<string, unknown> = letter.payload ?? {};
  const strategies: Array<[string, (cut: string) => string]> = [];
  if (typeof payload.content === "string") {
    strategies.push([payload.content, (cut) => JSON.stringify({ ...letter, payload: { ...payload, content: cut }, truncated: true })]);
  }
  strategies.push([JSON.stringify(payload), (cut) => JSON.stringify({ ...letter, payload: { truncatedPayload: cut }, truncated: true })]);
  return strategies;
}

/**
 * The letter as one JSON line that fits DEAD_LETTER_MAX_BYTES: an oversized
 * letter keeps the longest prefix of its payload content (or of the whole
 * payload, or of the malformed line) that fits, marked `truncated: true`.
 */
export function fitDeadLetter(letter: Letter): string {
  const line = JSON.stringify(letter);
  if (lineBytes(line) <= DEAD_LETTER_MAX_BYTES) return line;
  for (const [text, rebuild] of shrinkStrategies(letter)) {
    let best = rebuild("");
    if (lineBytes(best) > DEAD_LETTER_MAX_BYTES) continue;
    let lo = 0;
    let hi = Math.min(text.length, DEAD_LETTER_MAX_BYTES);
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const candidate = rebuild(text.slice(0, mid));
      if (lineBytes(candidate) <= DEAD_LETTER_MAX_BYTES) {
        best = candidate;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }
  const { deadAt, deadReason } = letter;
  return JSON.stringify("malformed" in letter ? { deadAt, deadReason, truncated: true } : {
    id: letter.id, projectId: letter.projectId, action: letter.action, deadAt, deadReason, truncated: true,
  });
}

/**
 * The dead-letter file after adding `added` (lines from fitDeadLetter): every
 * added line is kept, so a letter the user is told about is always there; the
 * older lines are pruned by age, then newest first within what is left of
 * DEAD_LETTER_MAX_BYTES.
 */
export function boundDeadLetters(existing: readonly string[], added: readonly string[], now: number): string[] {
  let budget = DEAD_LETTER_MAX_BYTES - added.reduce((sum, line) => sum + lineBytes(line), 0);
  const kept: string[] = [];
  for (let i = existing.length - 1; i >= 0; i--) {
    if (!isYoung(existing[i], now)) continue;
    budget -= lineBytes(existing[i]);
    if (budget < 0) break;
    kept.unshift(existing[i]);
  }
  return [...kept, ...added];
}

export class FileWriteQueue implements PendingWriteQueue {
  constructor(private readonly dir: string = defaultQueueDir()) {}

  private file(name: string): string {
    return path.join(this.dir, name);
  }

  /** Where undeliverable writes end up (reported to the user, never replayed). */
  get deadLetterFile(): string {
    return this.file(DEAD);
  }

  /** O_EXCL lock with stale takeover; null when still busy after waitMs. */
  private async acquire(name: string, waitMs: number): Promise<HeldLock | null> {
    await fs.mkdir(this.dir, { recursive: true, mode: DIR_MODE });
    await fs.chmod(this.dir, DIR_MODE);
    const lock = this.file(name);
    const deadline = Date.now() + waitMs;
    for (;;) {
      try {
        await (await fs.open(lock, "wx", FILE_MODE)).close();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const stat = await fs.stat(lock).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.rm(lock, { force: true });
          continue;
        }
        if (Date.now() >= deadline) return null;
        await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
      }
    }
    return {
      touch: async () => {
        const now = new Date();
        await fs.utimes(lock, now, now).catch(() => undefined);
      },
      release: () => fs.rm(lock, { force: true }),
    };
  }

  private async withQueueLock<T>(fn: () => Promise<T>, waitMs = LOCK_WAIT_MS): Promise<T | null> {
    const lock = await this.acquire(LOCK, waitMs);
    if (!lock) return null;
    try {
      return await fn();
    } finally {
      await lock.release();
    }
  }

  private async readAll(): Promise<{ entries: PendingWrite[]; malformed: string[] }> {
    const text = await fs.readFile(this.file(PENDING), "utf8").catch(() => "");
    const entries: PendingWrite[] = [];
    const malformed: string[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as PendingWrite);
      } catch {
        malformed.push(line); // never dropped silently: moved to the dead-letter file
      }
    }
    return { entries, malformed };
  }

  private async append(name: string, lines: string[]): Promise<void> {
    if (lines.length === 0) return;
    const handle = await fs.open(this.file(name), "a", FILE_MODE);
    try {
      await handle.appendFile(lines.join(""), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async writeAtomic(name: string, lines: readonly string[]): Promise<void> {
    const target = this.file(name);
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, lines.map((line) => `${line}\n`).join(""), { mode: FILE_MODE });
    await fs.rename(tmp, target);
  }

  /** Under the queue lock. */
  private async addDeadLetters(letters: readonly Letter[], now: number): Promise<void> {
    if (letters.length === 0) return;
    const existing = (await fs.readFile(this.file(DEAD), "utf8").catch(() => "")).split("\n").filter((l) => l.trim());
    await this.writeAtomic(DEAD, boundDeadLetters(existing, letters.map(fitDeadLetter), now));
  }

  async enqueue(write: PendingWrite): Promise<void> {
    const line = `${JSON.stringify(write)}\n`;
    const saved = await this.withQueueLock(async () => {
      const size = (await fs.stat(this.file(PENDING)).catch(() => null))?.size ?? 0;
      if (size + Buffer.byteLength(line) > MAX_BYTES) throw new WriteQueueFullError();
      if ((await this.readAll()).entries.length >= MAX_PENDING_WRITES) throw new WriteQueueFullError();
      await this.append(PENDING, [line]);
      return true;
    });
    if (saved === null) throw new Error("Munin local write queue is busy; the write was NOT saved");
  }

  async drain(send: (write: PendingWrite) => Promise<DrainVerdict>): Promise<DrainReport> {
    const drainLock = await this.acquire(DRAIN_LOCK, 0);
    // Another process is draining right now: nothing to do here.
    if (!drainLock) return { ...EMPTY_DRAIN_REPORT, remaining: await this.size() };
    try {
      const snapshot = await this.withQueueLock(async () => (await this.readAll()).entries);
      if (snapshot === null) return { ...EMPTY_DRAIN_REPORT, remaining: await this.size() };
      const outcome = await drainEntries(snapshot, send, { afterEach: drainLock.touch });
      const report = await this.withQueueLock(async () => {
        const now = Date.now();
        const { entries, malformed } = await this.readAll();
        const next = applyOutcome(entries, outcome);
        const deadAt = new Date(now).toISOString();
        const malformedLetters = malformed.map((raw): MalformedLetter => ({ malformed: raw, deadAt, deadReason: "malformed" }));
        await this.addDeadLetters([...outcome.dead, ...malformedLetters], now);
        await this.writeAtomic(PENDING, next.map((e) => JSON.stringify(e)));
        const base = reportOf(outcome, next.length);
        return { ...base, dead: base.dead + malformed.length };
      }, RECONCILE_LOCK_WAIT_MS);
      if (report === null) throw new Error("Munin local write queue stayed busy; sent writes may be sent again");
      return report;
    } finally {
      await drainLock.release();
    }
  }

  async size(): Promise<number> {
    return (await this.readAll()).entries.length;
  }

  /**
   * No lock: the file is only ever appended to under the lock or replaced by
   * an atomic rename, so a reader sees a whole snapshot (a half-written last
   * line parses as malformed and is ignored here). While a drain is sending,
   * its entries are still in the file: conservative.
   */
  async has(match: (write: PendingWrite) => boolean): Promise<boolean> {
    return (await this.readAll()).entries.some(match);
  }
}

export function createFileWriteQueue(dir?: string): FileWriteQueue {
  return new FileWriteQueue(dir);
}
