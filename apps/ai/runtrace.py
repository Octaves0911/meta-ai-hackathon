"""Run trace ("What the agent did"): ordered steps with timing, streamed to the backend as they happen (docs/09 §1.4)."""
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import httpx

MAX_STEPS = 8  # per execution (docs/09 §1.6)
KINDS = ("plan", "search", "read", "consult", "tool", "draft", "check")


class LimitExceeded(Exception):
    pass


def _iso(t: float) -> str:
    return datetime.fromtimestamp(t, tz=timezone.utc).isoformat()


class Trace:
    def __init__(self, execution_id: str | None = None, revision: int = 0, callback_url: str | None = None, secret: str = "", max_steps: int = MAX_STEPS):
        self.execution_id, self.revision, self.callback_url, self.secret = execution_id, revision, callback_url, secret
        self.max_steps = max_steps
        self.steps: list[dict] = []

    async def _emit(self, step: dict) -> None:
        """Best effort: a lost progress event must never fail the run."""
        if not (self.execution_id and self.callback_url):
            return
        try:
            async with httpx.AsyncClient(timeout=3) as c:
                await c.post(f"{self.callback_url.rstrip('/')}/api/internal/executions/{self.execution_id}/steps",
                             json={**step, "revision": self.revision}, headers={"x-internal-secret": self.secret})
        except httpx.HTTPError:
            pass

    @asynccontextmanager
    async def step(self, kind: str, label: str, detail: dict | None = None):
        if len(self.steps) >= self.max_steps:
            raise LimitExceeded(f"step limit of {self.max_steps} reached")
        s = {"seq": len(self.steps), "kind": kind if kind in KINDS else "tool", "label": label[:200], "detail": detail or {}, "status": "running", "started_at": _iso(time.time()), "ended_at": None}
        self.steps.append(s)
        t0 = time.monotonic()
        await self._emit(s)
        try:
            yield s
            s["status"] = "done"
        except BaseException:
            s["status"] = "failed"
            raise
        finally:
            s["ended_at"] = _iso(time.time())
            s["detail"] = {**s["detail"], "seconds": round(time.monotonic() - t0, 2)}
            await self._emit(s)
