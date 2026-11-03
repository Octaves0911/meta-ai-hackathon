"""Types shared by the sandbox backends and the verification orchestrator (docs/09 §2.5). AI-written code is only ever executed inside a sandbox
session created through a Backend; nothing here runs a command on the host."""
from dataclasses import dataclass, field
from typing import Literal

Network = Literal["none", "registries", "registries+github"]

# Domains the SETUP phase may reach (package registries; GitHub only when cloning). The RUN phase has no network at all.
REGISTRY_DOMAINS = ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"]
GITHUB_DOMAINS = ["github.com", "codeload.github.com", "objects.githubusercontent.com"]

MAX_OUTPUT_CHARS = 12_000   # per command; the tail is what explains a failure
INSTALL_TIMEOUT = 420
TEST_TIMEOUT = 300
SESSION_LIFETIME = 900      # hard cap for one sandbox, seconds
DEFAULT_CPU = 1.0
DEFAULT_MEMORY_MB = 2048

# Modal bills per second; these are estimates for the cost shown to reviewers (verify on Modal's pricing page).
CPU_CORE_SECOND_USD = 0.00003942
MEM_GIB_SECOND_USD = 0.00000667


def estimate_cost(seconds: float, cpu: float = DEFAULT_CPU, memory_mb: int = DEFAULT_MEMORY_MB) -> float:
    return round(seconds * (cpu * CPU_CORE_SECOND_USD + (memory_mb / 1024) * MEM_GIB_SECOND_USD), 6)


@dataclass
class SessionSpec:
    image: str = "polyglot"               # "polyglot" (git + Node 20 + Python 3) or a registry image
    network: Network = "none"
    from_snapshot: str | None = None
    cpu: float = DEFAULT_CPU
    memory_mb: int = DEFAULT_MEMORY_MB
    lifetime_s: int = SESSION_LIFETIME


@dataclass
class CommandResult:
    cmd: list[str]
    exit_code: int
    seconds: float = 0.0
    stdout: str = ""
    stderr: str = ""
    timed_out: bool = False

    @property
    def ok(self) -> bool:
        return self.exit_code == 0 and not self.timed_out

    def tail(self, n: int = MAX_OUTPUT_CHARS) -> str:
        text = (self.stdout + ("\n" + self.stderr if self.stderr else "")).strip()
        return text[-n:]


@dataclass
class Step:
    """One line of evidence: what ran, in which phase, and how it ended (output truncated)."""
    phase: Literal["setup", "run"]
    label: str
    cmd: list[str]
    exit_code: int
    seconds: float
    timed_out: bool
    output: str
    counts: dict = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.exit_code == 0 and not self.timed_out


@dataclass
class Verification:
    status: Literal["verified", "failed", "not_tested"]
    reason: str = ""
    ecosystem: str = ""
    steps: list[Step] = field(default_factory=list)
    seconds: float = 0.0
    cost_usd: float = 0.0
    # test evidence
    red_exit: int | None = None     # exit code of the new tests alone, before the change (expected to FAIL)
    green_exit: int | None = None   # exit code after the change (expected to PASS)
    warnings: list[str] = field(default_factory=list)

    def summary(self) -> str:
        if self.status == "verified":
            t = next((s for s in reversed(self.steps) if s.label == "tests"), None)
            c = t.counts if t else {}
            n = f" ({c['passed']} passed)" if c.get("passed") is not None else ""
            return f"Verified{n}"
        return "Failed verification" if self.status == "failed" else "Not tested"


class SandboxError(Exception):
    """The sandbox itself failed (not the code under test): credentials, quota, timeout creating it."""
