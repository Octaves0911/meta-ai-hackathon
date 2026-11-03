"""Sandbox backends. `ModalBackend` is the real one; `ScriptedBackend` is for tests and NEVER executes anything; `MockBackend` (SANDBOX_MODE=mock)
returns canned success for offline demos. There is deliberately no local-process backend: generated code does not run on this machine."""
import os
import shlex
import time
from abc import ABC, abstractmethod
from typing import Callable

from sandbox.types import GITHUB_DOMAINS, MAX_OUTPUT_CHARS, REGISTRY_DOMAINS, CommandResult, SandboxError, SessionSpec


class Session(ABC):
    spec: SessionSpec

    @abstractmethod
    async def put_file(self, path: str, data: bytes) -> None: ...

    @abstractmethod
    async def run(self, cmd: list[str], *, timeout: int, env: dict[str, str] | None = None, workdir: str | None = None) -> CommandResult: ...

    @abstractmethod
    async def snapshot(self) -> str: ...

    @abstractmethod
    async def close(self) -> None: ...


class Backend(ABC):
    @abstractmethod
    async def open(self, spec: SessionSpec) -> Session: ...


# ---------------------------------------------------------------- test double: records everything, executes nothing
class ScriptedSession(Session):
    def __init__(self, backend: "ScriptedBackend", spec: SessionSpec, index: int):
        self.backend, self.spec, self.index = backend, spec, index
        self.commands: list[dict] = []
        self.files: dict[str, bytes] = {}
        self.closed = False

    async def put_file(self, path: str, data: bytes) -> None:
        self.files[path] = data

    async def run(self, cmd, *, timeout, env=None, workdir=None):
        self.commands.append({"cmd": list(cmd), "timeout": timeout, "env": dict(env or {}), "workdir": workdir})
        res = self.backend.script(self, list(cmd))
        return res if isinstance(res, CommandResult) else CommandResult(list(cmd), int(res))

    async def snapshot(self) -> str:
        return f"snap-{self.index}"

    async def close(self) -> None:
        self.closed = True


class ScriptedBackend(Backend):
    """`script(session, cmd)` decides each command's result (an exit code or a CommandResult)."""

    def __init__(self, script: Callable[[ScriptedSession, list[str]], "int | CommandResult"] = lambda s, c: 0):
        self.script = script
        self.sessions: list[ScriptedSession] = []

    async def open(self, spec: SessionSpec) -> Session:
        s = ScriptedSession(self, spec, len(self.sessions))
        self.sessions.append(s)
        return s


class MockBackend(ScriptedBackend):
    """SANDBOX_MODE=mock: everything 'passes' so the whole flow can be demonstrated offline. Results are labelled as mock by the caller."""

    def __init__(self) -> None:
        def ok(session, cmd):
            if cmd[:2] == ["git", "ls-files"] or "ls-files" in " ".join(cmd):
                return CommandResult(cmd, 0, stdout="package.json\npackage-lock.json\nsrc/app.js\ntest/app.test.js\n")
            if cmd and cmd[0] == "cat" and cmd[-1].endswith("package.json"):
                return CommandResult(cmd, 0, stdout='{"scripts":{"test":"node --test"}}')
            if cmd[:2] == ["npm", "test"]:
                return CommandResult(cmd, 0, stdout="ℹ tests 3\nℹ pass 3\nℹ fail 0\n")
            return CommandResult(cmd, 0)
        super().__init__(ok)


# ---------------------------------------------------------------- the real backend (Modal)
# One image with git, Node 20 and Python 3 so any supported repository works in a single sandbox; dependencies are installed in the setup
# phase and carried to the network-less run phase by filesystem snapshot.
POLYGLOT_BASE = "node:20-bookworm"
POLYGLOT_APT = ["python3", "python3-pip", "git"]


class ModalSession(Session):
    """One Modal Sandbox. Files go in through stdin of an exec (no reliance on filesystem helpers); results come back through stdout/stderr."""

    def __init__(self, sandbox, spec: SessionSpec):
        self.sb, self.spec = sandbox, spec

    async def put_file(self, path: str, data: bytes) -> None:
        proc = await self.sb.exec.aio("sh", "-c", f"mkdir -p $(dirname {shlex.quote(path)}) && cat > {shlex.quote(path)}", text=False)
        proc.stdin.write(data)
        proc.stdin.write_eof()
        await proc.stdin.drain.aio()
        if await proc.wait.aio() != 0:
            raise SandboxError(f"could not write {path} into the sandbox")

    async def run(self, cmd, *, timeout, env=None, workdir=None):
        t0 = time.monotonic()
        try:
            proc = await self.sb.exec.aio(*cmd, timeout=timeout, workdir=workdir, env=env or None)
            out = await proc.stdout.read.aio()
            err = await proc.stderr.read.aio()
            code = await proc.wait.aio()
            return CommandResult(list(cmd), int(code), time.monotonic() - t0, (out or "")[-MAX_OUTPUT_CHARS:], (err or "")[-MAX_OUTPUT_CHARS:])
        except Exception as e:  # noqa: BLE001 - modal raises ExecTimeoutError / SandboxTimeoutError / transport errors
            name = type(e).__name__
            if "Timeout" in name:
                return CommandResult(list(cmd), 124, time.monotonic() - t0, "", f"timed out after {timeout}s", timed_out=True)
            raise SandboxError(f"sandbox command failed: {name}") from e

    async def snapshot(self) -> str:
        image = await self.sb.snapshot_filesystem.aio()
        return image.object_id

    async def close(self) -> None:
        try:
            await self.sb.terminate.aio()
        except Exception:  # noqa: BLE001 - best effort; the lifetime cap ends it anyway
            pass


class ModalBackend(Backend):
    """Needs MODAL_TOKEN_ID / MODAL_TOKEN_SECRET (or `modal token new`). NOT exercised against real Modal in this repository's tests."""

    def __init__(self, app_name: str = "meetpilot-sandbox"):
        try:
            import modal  # lazy: the rest of the service must work without the SDK or credentials
        except ImportError as e:
            raise SandboxError("the modal package is not installed") from e
        if not (os.environ.get("MODAL_TOKEN_ID") and os.environ.get("MODAL_TOKEN_SECRET")) and not os.path.exists(os.path.expanduser("~/.modal.toml")):
            raise SandboxError("Modal credentials are not configured (MODAL_TOKEN_ID / MODAL_TOKEN_SECRET)")
        self.modal = modal
        self.app_name = app_name
        self._app = None

    async def _get_app(self):
        if self._app is None:
            self._app = await self.modal.App.lookup.aio(self.app_name, create_if_missing=True)
        return self._app

    async def open(self, spec: SessionSpec) -> Session:
        modal = self.modal
        try:
            app = await self._get_app()
            if spec.from_snapshot:
                image = await modal.Image.from_id.aio(spec.from_snapshot)
            else:
                image = modal.Image.from_registry(POLYGLOT_BASE).apt_install(*POLYGLOT_APT) if spec.image == "polyglot" else modal.Image.from_registry(spec.image)
            net: dict = {}
            if spec.network == "none":
                net["block_network"] = True
            else:
                net["outbound_domain_allowlist"] = REGISTRY_DOMAINS + (GITHUB_DOMAINS if spec.network == "registries+github" else [])
            sb = await modal.Sandbox.create.aio("sleep", str(spec.lifetime_s), app=app, image=image, timeout=spec.lifetime_s, workdir="/work",
                                                cpu=spec.cpu, memory=spec.memory_mb, runtime="gvisor", **net)
        except SandboxError:
            raise
        except Exception as e:  # noqa: BLE001 - auth, quota, image build failures
            raise SandboxError(f"could not start a sandbox: {type(e).__name__}") from e
        return ModalSession(sb, spec)


def get_backend() -> Backend | None:
    """SANDBOX_MODE=modal (needs credentials) | mock | off (default: modal when credentials exist, else off)."""
    mode = os.environ.get("SANDBOX_MODE", "").lower()
    if mode == "off":
        return None
    if mode == "mock":
        return MockBackend()
    if mode == "modal" or os.environ.get("MODAL_TOKEN_ID"):
        return ModalBackend()
    return None
