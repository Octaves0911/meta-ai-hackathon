"""Ecosystem detection and the command plan. Commands come from THESE templates, never from the model: the model cannot choose what runs.
(What `npm test` or `pytest` then executes is the project's own code, which is exactly what the sandbox exists to contain.)"""
import json
import re
from dataclasses import dataclass, field


@dataclass
class Plan:
    ecosystem: str
    image: str
    install: list[list[str]] = field(default_factory=list)
    test: list[str] | None = None
    lint: list[str] | None = None
    build: list[str] | None = None


TEST_FILE = re.compile(r"(^|/)(tests?|__tests__|spec)/|\.(test|spec)\.[jt]sx?$|(^|/)test_[^/]+\.py$|_test\.(py|go)$", re.I)


def is_test_path(path: str) -> bool:
    return bool(TEST_FILE.search(path))


def detect(files: list[str], package_json: str | None = None) -> Plan | None:
    """Look at the repository's file list (and package.json if it has one). Returns None when nothing runnable is recognised."""
    names = set(files)
    if "package.json" in names:
        scripts: dict = {}
        try:
            scripts = (json.loads(package_json or "{}").get("scripts") or {}) if package_json else {}
        except (ValueError, AttributeError):
            scripts = {}
        lock = "package-lock.json" in names
        plan = Plan("node", "polyglot", install=[["npm", "ci", "--no-audit", "--no-fund"] if lock else ["npm", "install", "--no-audit", "--no-fund"]])
        if "test" in scripts and "no test specified" not in str(scripts["test"]):
            plan.test = ["npm", "test", "--silent"]
        if "lint" in scripts:
            plan.lint = ["npm", "run", "lint", "--silent"]
        if "build" in scripts:
            plan.build = ["npm", "run", "build", "--silent"]
        return plan
    if names & {"pyproject.toml", "requirements.txt", "setup.py", "setup.cfg"}:
        plan = Plan("python", "polyglot")
        if "requirements.txt" in names:
            plan.install.append(["python3", "-m", "pip", "install", "--quiet", "--break-system-packages", "-r", "requirements.txt"])
        if names & {"pyproject.toml", "setup.py"}:
            plan.install.append(["python3", "-m", "pip", "install", "--quiet", "--break-system-packages", "-e", "."])
        plan.install.append(["python3", "-m", "pip", "install", "--quiet", "--break-system-packages", "pytest"])
        if any(is_test_path(f) for f in files):
            plan.test = ["python3", "-m", "pytest", "-q", "-x", "--no-header", "-p", "no:cacheprovider"]
        return plan
    return None


def split_patch(patch: str) -> tuple[str, str]:
    """Split a unified diff into (tests-only part, everything else), by file, so the new tests can be run on their own first (must fail)."""
    blocks = re.split(r"(?m)^(?=diff --git )", patch)
    tests, rest = [], []
    for b in blocks:
        if not b.strip():
            continue
        m = re.match(r"diff --git a/(\S+) b/(\S+)", b)
        (tests if m and is_test_path(m.group(2)) else rest).append(b)
    return "".join(tests), "".join(rest)


def patch_files(patch: str) -> list[str]:
    return re.findall(r"(?m)^diff --git a/\S+ b/(\S+)", patch)
