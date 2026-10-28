class MuninSdkError(Exception):
    def __init__(self, code: str, message: str, details: dict | None = None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


class MuninTransportError(Exception):
    pass


class MuninMaintenanceError(MuninSdkError):
    """Munin is in a maintenance window. Already retried; the write was queued when `queued` is True."""

    retryable = False

    def __init__(self, action: str, queued: bool, retry_after_s: float | None, queue_id: str | None = None,
                 reason: str = "maintenance"):
        # reason "pending": older queued writes of the project could not be sent
        # yet, so this one waits behind them (the server may well be up).
        if reason == "pending":
            message = ("Older Munin writes for this project are still waiting to be sent. The write was saved "
                       "locally behind them and will be retried automatically.")
        elif queued:
            message = "Munin is in maintenance (read-only). The write was saved locally and will be retried automatically."
        else:
            message = "Munin is in maintenance (read-only). Please try again later."
        super().__init__("MAINTENANCE_READ_ONLY", message, {"action": action, "queued": queued,
                         "retryAfterS": retry_after_s, "queueId": queue_id, "reason": reason})
        self.queued = queued
        self.retry_after_s = retry_after_s
        self.queue_id = queue_id
