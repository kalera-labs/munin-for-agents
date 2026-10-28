import type { MuninError } from "./types.js";

export class MuninSdkError extends Error {
  public readonly code: MuninError["code"];
  public readonly details?: Record<string, unknown>;

  constructor(error: MuninError) {
    super(error.message);
    this.name = "MuninSdkError";
    this.code = error.code;
    this.details = error.details;
  }
}

export class MuninTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MuninTransportError";
  }
}

/**
 * maintenance: the server answered MAINTENANCE_READ_ONLY · pending: older
 * queued writes of the project could not be sent yet, so this write waits
 * behind them (the server may well be up).
 */
export type MaintenanceReason = "maintenance" | "pending";

export interface MaintenanceInfo {
  queued: boolean;
  reason?: MaintenanceReason;
  action: string;
  retryAfterMs: number | null;
  queueId?: string;
}

function maintenanceMessage(info: MaintenanceInfo): string {
  if (info.reason === "pending") {
    return info.queued
      ? "Older Munin writes for this project are still waiting to be sent. The write was saved locally behind them and will be retried automatically."
      : "Older Munin writes for this project are still waiting to be sent. Please try again later.";
  }
  return info.queued
    ? "Munin is in maintenance (read-only). The write was saved locally and will be retried automatically."
    : "Munin is in maintenance (read-only). Please try again later.";
}

/**
 * Munin is in a maintenance window (server MUNIN_READ_ONLY). Not retryable by
 * the caller: the client already retried, and a write was queued locally when
 * `queued` is true.
 */
export class MuninMaintenanceError extends MuninSdkError {
  public readonly queued: boolean;
  public readonly retryAfterMs: number | null;
  public readonly queueId?: string;
  public readonly retryable = false;

  constructor(info: MaintenanceInfo) {
    super({
      code: "MAINTENANCE_READ_ONLY",
      message: maintenanceMessage(info),
      details: { ...info },
    });
    this.name = "MuninMaintenanceError";
    this.queued = info.queued;
    this.retryAfterMs = info.retryAfterMs;
    this.queueId = info.queueId;
  }
}
