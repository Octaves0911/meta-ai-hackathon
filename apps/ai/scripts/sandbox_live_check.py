"""Live check of the Modal sandbox path. Needs MODAL_TOKEN_ID and MODAL_TOKEN_SECRET (https://modal.com/settings/tokens).

    cd apps/ai && MODAL_TOKEN_ID=... MODAL_TOKEN_SECRET=... .venv/bin/python scripts/sandbox_live_check.py

It runs a tiny Node project through the real orchestrator: a patch with a new test that must FAIL before the fix and PASS after (verified),
a patch that breaks the tests (failed), a patch that does not apply (failed), and probes that the run phase really has no network and the setup
phase can reach npm but not arbitrary sites. Costs a few cents. Prints PASS/FAIL per check."""
import asyncio
import io
import sys
import tarfile

sys.path.insert(0, ".")
from sandbox import SessionSpec, verify_change  # noqa: E402
from sandbox.backends import ModalBackend  # noqa: E402
from sandbox.verify import RepoSource  # noqa: E402

PROJECT = {
    "package.json": '{"name":"demo","version":"1.0.0","scripts":{"test":"node --test"}}\n',
    "package-lock.json": '{"name":"demo","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"demo","version":"1.0.0"}}}\n',
    "src/add.js": "module.exports = (a, b) => a - b;\n",
    "test/sanity.test.js": "const test = require('node:test');\nconst assert = require('node:assert');\ntest('sanity', () => { assert.ok(true); });\n",
}
NEW_TEST = ("const test = require('node:test');\nconst assert = require('node:assert');\nconst add = require('../src/add.js');\n"
            "test('adds', () => { assert.strictEqual(add(2, 3), 5); });\n")


def new_file(path: str, text: str) -> str:
    lines = text.splitlines()
    return f"diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{len(lines)} @@\n" + "".join(f"+{ln}\n" for ln in lines)


def edit_line(path: str, old: str, new: str) -> str:
    return f"diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n@@ -1 +1 @@\n-{old}\n+{new}\n"


GOOD = new_file("test/add.test.js", NEW_TEST) + edit_line("src/add.js", "module.exports = (a, b) => a - b;", "module.exports = (a, b) => a + b;")
BREAKS = new_file("test/add.test.js", NEW_TEST) + edit_line("src/add.js", "module.exports = (a, b) => a - b;", "module.exports = (a, b) => a * b;")
DOES_NOT_APPLY = edit_line("src/add.js", "this line does not exist", "x")


def tarball() -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as t:
        for name, text in PROJECT.items():
            data = text.encode()
            info = tarfile.TarInfo(name)
            info.size = len(data)
            t.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def check(name: str, cond: bool, extra: object = "") -> bool:
    print("PASS" if cond else "FAIL", name, "" if cond else extra)
    return cond


async def main() -> int:
    backend = ModalBackend()
    repo = RepoSource(tarball=tarball())
    ok = True
    v = await verify_change(backend, repo, GOOD)
    ok &= check("good change is verified", v.status == "verified", (v.status, v.reason, [(s.label, s.exit_code, s.output[-200:]) for s in v.steps]))
    ok &= check("the new test failed before the fix and passed after", v.red_exit not in (None, 0) and v.green_exit == 0, (v.red_exit, v.green_exit))
    print("  cost estimate $%.4f, %.0f s, steps: %s" % (v.cost_usd, v.seconds, [s.label for s in v.steps]))
    v = await verify_change(backend, repo, BREAKS)
    ok &= check("a change that breaks the tests is rejected", v.status == "failed", (v.status, v.reason))
    v = await verify_change(backend, repo, DOES_NOT_APPLY)
    ok &= check("a patch that does not apply is rejected", v.status == "failed" and "does not apply" in v.reason, (v.status, v.reason))

    # network probes
    for network, url, expect_reachable in (("none", "https://registry.npmjs.org/", False), ("registries", "https://registry.npmjs.org/", True), ("registries", "https://example.com/", False)):
        s = await backend.open(SessionSpec(network=network))  # type: ignore[arg-type]
        try:
            r = await s.run(["sh", "-c", f"curl -sS -m 10 -o /dev/null -w '%{{http_code}}' {url}"], timeout=40)
        finally:
            await s.close()
        reachable = r.ok and r.stdout.strip().startswith(("2", "3"))
        ok &= check(f"network={network}: {url} {'reachable' if expect_reachable else 'blocked'}", reachable == expect_reachable, (r.exit_code, r.stdout, r.stderr[-120:]))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
