"""Verification orchestrator (docs/09 §2.5): setup phase (network only to package registries, GitHub only when cloning) installs dependencies and is
snapshotted; the run phase starts from that snapshot with NO network and no secrets, applies the patch and runs the project's tests, lint and build.
A change is 'verified' only when the tests actually ran and passed."""
import base64
import re
import time
from dataclasses import dataclass

from sandbox.backends import Backend, Session
from sandbox.detect import Plan, detect, patch_files, split_patch
from sandbox.parse import parse_counts
from sandbox.types import (INSTALL_TIMEOUT, MAX_OUTPUT_CHARS, TEST_TIMEOUT, CommandResult, SandboxError, SessionSpec, Step, Verification, estimate_cost)

WORKDIR = "/work"
GIT_ID = ["-c", "user.name=meetpilot", "-c", "user.email=meetpilot@localhost"]


@dataclass
class RepoSource:
    clone_url: str | None = None     # https://github.com/owner/name.git
    ref: str | None = None           # branch or tag; default branch if None
    token: str | None = None         # read-only clone credential: setup phase only, passed in the environment, never written, never in evidence
    tarball: bytes | None = None     # alternative: an uploaded copy of the workspace (.tar.gz)


def redact(text: str, secrets: list[str | None]) -> str:
    for s in secrets:
        if s and len(s) >= 6:
            text = text.replace(s, "***")
    return text


class _Run:
    """Collects steps and time for one verification, across both sessions."""

    def __init__(self, secrets: list[str | None]):
        self.steps: list[Step] = []
        self.cost = 0.0
        self.secrets = secrets
        self.phase_seconds = {"setup": 0.0, "run": 0.0}

    async def run(self, session: Session, phase: str, label: str, cmd: list[str], *, timeout: int, env: dict | None = None) -> Step:
        t0 = time.monotonic()
        res: CommandResult = await session.run(cmd, timeout=timeout, env=env, workdir=WORKDIR)
        dur = res.seconds or (time.monotonic() - t0)
        out = redact(res.tail(MAX_OUTPUT_CHARS), self.secrets)
        step = Step(phase=phase, label=label, cmd=[redact(c, self.secrets) for c in cmd], exit_code=res.exit_code, seconds=round(dur, 2),  # type: ignore[arg-type]
                    timed_out=res.timed_out, output=out, counts=parse_counts(out) if label.startswith("tests") else {})
        self.steps.append(step)
        self.phase_seconds[phase] = self.phase_seconds.get(phase, 0.0) + dur
        return step

    def add_session(self, spec: SessionSpec, wall: float, phase: str) -> None:
        """Billed time is at least what the commands themselves took."""
        self.cost += estimate_cost(max(wall, self.phase_seconds.get(phase, 0.0)), spec.cpu, spec.memory_mb)


def _basic(token: str) -> str:
    return base64.b64encode(f"x-access-token:{token}".encode()).decode()


async def verify_change(backend: Backend | None, repo: RepoSource, patch: str, *, patch_ref: str = "the base branch") -> Verification:
    """Run `patch` against `repo` in the sandbox. Never raises for problems with the code under test: those become status 'failed'.
    Problems with the sandbox itself (no credentials, quota) become 'not_tested' with the reason."""
    if backend is None:
        return Verification("not_tested", "The sandbox is switched off, so nothing was run.")
    if not patch.strip():
        return Verification("not_tested", "There is no change to verify.")
    if not (repo.clone_url or repo.tarball):
        return Verification("not_tested", "No repository was given.")
    run = _Run([repo.token])
    t_start = time.monotonic()
    setup: Session | None = None
    run_s: Session | None = None
    v = Verification("not_tested")

    def end(status: str, reason: str) -> Verification:  # every exit goes through here so steps, time and cost are always recorded on the same object
        v.status, v.reason = status, reason  # type: ignore[assignment]
        return v

    try:
        # ---- setup phase: network only to registries (+ GitHub for the clone)
        spec = SessionSpec(network="registries+github" if repo.clone_url else "registries")
        t0 = time.monotonic()
        setup = await backend.open(spec)
        env = {"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "http.extraheader", "GIT_CONFIG_VALUE_0": f"Authorization: Basic {_basic(repo.token)}"} if repo.token else None
        if repo.clone_url:
            cmd = ["git", "clone", "--quiet", "--depth", "1", *(["--branch", repo.ref] if repo.ref else []), repo.clone_url, WORKDIR]
            s = await run.run(setup, "setup", "clone", cmd, timeout=INSTALL_TIMEOUT, env=env)
        else:
            await setup.put_file("/tmp/src.tgz", repo.tarball or b"")
            s = await run.run(setup, "setup", "unpack", ["sh", "-c", f"mkdir -p {WORKDIR} && tar xzf /tmp/src.tgz -C {WORKDIR}"], timeout=120)
            if s.ok:  # `git apply` needs a repository
                s = await run.run(setup, "setup", "init", ["sh", "-c", f"cd {WORKDIR} && (git rev-parse --git-dir >/dev/null 2>&1 || (git init -q && git add -A && git {' '.join(GIT_ID)} commit -qm base))"], timeout=120)
        if not s.ok:
            return end("failed", "The repository could not be fetched into the sandbox.")
        files_res = await setup.run(["git", "-C", WORKDIR, "ls-files"], timeout=60)
        files = [f for f in files_res.stdout.splitlines() if f.strip()][:5000]
        pkg = None
        if "package.json" in files:
            pkg = (await setup.run(["cat", f"{WORKDIR}/package.json"], timeout=30)).stdout
        plan: Plan | None = detect(files, pkg)
        if plan is None:
            return end("not_tested", "No supported project type was recognised (Node or Python), so no tests could be run.")
        v.ecosystem = plan.ecosystem
        for cmd in plan.install:
            s = await run.run(setup, "setup", "install", cmd, timeout=INSTALL_TIMEOUT)
            if not s.ok:
                return end("failed", "Dependencies could not be installed in the sandbox.")
        snap = await setup.snapshot()
        run.add_session(setup.spec, time.monotonic() - t0, "setup")
        await setup.close()
        setup = None

        # ---- run phase: from the snapshot, no network, no secrets
        rspec = SessionSpec(network="none", from_snapshot=snap)
        t1 = time.monotonic()
        run_s = await backend.open(rspec)
        renv = {"CI": "true"}
        if plan.test:
            base = await run.run(run_s, "run", "tests (before the change)", plan.test, timeout=TEST_TIMEOUT, env=renv)
            if not base.ok:
                v.warnings.append("The project's tests were already failing before the change.")
        tests_patch, rest_patch = split_patch(patch)
        v.warnings = list(v.warnings)
        if tests_patch and rest_patch and plan.test:
            await run_s.put_file("/tmp/tests.patch", tests_patch.encode())
            await run_s.put_file("/tmp/src.patch", rest_patch.encode())
            for name, label in (("tests.patch", "apply the new tests"),):
                s = await run.run(run_s, "run", label, ["git", *GIT_ID, "apply", f"/tmp/{name}"], timeout=60)
                if not s.ok:
                    return end("failed", f"The patch does not apply to {patch_ref}: {s.output[-300:]}")
            red = await run.run(run_s, "run", "tests (new tests only, before the fix)", plan.test, timeout=TEST_TIMEOUT, env=renv)
            v.red_exit = red.exit_code
            if red.ok:
                v.warnings.append("The new tests already pass without the change, so they may not test it.")
            s = await run.run(run_s, "run", "apply the change", ["git", *GIT_ID, "apply", "/tmp/src.patch"], timeout=60)
            if not s.ok:
                return end("failed", f"The change does not apply to {patch_ref}: {s.output[-300:]}")
        else:
            await run_s.put_file("/tmp/change.patch", patch.encode())
            s = await run.run(run_s, "run", "apply the change", ["git", *GIT_ID, "apply", "/tmp/change.patch"], timeout=60)
            if not s.ok:
                return end("failed", f"The patch does not apply to {patch_ref}: {s.output[-300:]}")

        failed = ""
        if plan.test:
            t = await run.run(run_s, "run", "tests", plan.test, timeout=TEST_TIMEOUT, env=renv)
            v.green_exit = t.exit_code
            if not t.ok:
                failed = "The tests failed after the change." if not t.timed_out else "The tests timed out."
        for label, cmd in (("lint", plan.lint), ("build", plan.build)):
            if cmd and not failed:
                s = await run.run(run_s, "run", label, cmd, timeout=TEST_TIMEOUT, env=renv)
                if not s.ok:
                    failed = f"The {label} step failed after the change."
        run.add_session(rspec, time.monotonic() - t1, "run")
        if failed:
            return end("failed", failed)
        if not plan.test:
            return end("not_tested", "The project has no test command, so the change could not be verified.")
        return end("verified", "")
    except SandboxError as e:
        return end("not_tested", f"The sandbox could not run: {e}")
    finally:
        for sess in (setup, run_s):
            if sess is not None:
                try:
                    await sess.close()
                except Exception:  # noqa: BLE001
                    pass
        v.steps = run.steps
        v.seconds = round(time.monotonic() - t_start, 2)
        v.cost_usd = round(run.cost, 6)
