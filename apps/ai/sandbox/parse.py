"""Best-effort test counts from common runners. The exit code is the truth; counts are extra evidence for the reviewer."""
import re


def parse_counts(output: str) -> dict:
    t = output or ""
    c: dict = {}
    m = re.search(r"(\d+) passed", t)                      # pytest, vitest
    if m:
        c["passed"] = int(m.group(1))
        f = re.search(r"(\d+) failed", t)
        c["failed"] = int(f.group(1)) if f else 0
        s = re.search(r"(\d+) skipped", t)
        if s:
            c["skipped"] = int(s.group(1))
        return c
    m = re.search(r"Tests:\s+(?:(\d+) failed, )?(?:\d+ skipped, )?(\d+) passed", t)  # jest
    if m:
        return {"passed": int(m.group(2)), "failed": int(m.group(1) or 0)}
    m = re.search(r"(?m)^\W*(?:ℹ )?pass (\d+)\s*$", t)           # node:test
    if m:
        f = re.search(r"(?m)^\W*(?:ℹ )?fail (\d+)\s*$", t)
        return {"passed": int(m.group(1)), "failed": int(f.group(1)) if f else 0}
    m = re.search(r"(\d+) passing", t)                      # mocha
    if m:
        f = re.search(r"(\d+) failing", t)
        return {"passed": int(m.group(1)), "failed": int(f.group(1)) if f else 0}
    return c
