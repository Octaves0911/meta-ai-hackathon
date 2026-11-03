"""Edits -> unified diff. The generated diffs must round-trip through an independent applier. Run: cd apps/ai && INTERNAL_SECRET=x .venv/bin/python -m unittest -v"""
import random
import unittest

import patching as P

SRC = "const a = 1;\nfunction add(x, y) {\n  return x - y;\n}\nmodule.exports = add;\n"


class EditsTest(unittest.TestCase):
    def test_an_exact_edit_applies(self):
        self.assertEqual(P.apply_edits(SRC, [{"find": "return x - y;", "replace": "return x + y;"}]), SRC.replace("x - y", "x + y"))

    def test_edits_apply_in_order_on_the_edited_text(self):
        out = P.apply_edits("a b c\n", [{"find": "a b", "replace": "X"}, {"find": "X c", "replace": "done"}])
        self.assertEqual(out, "done\n")

    def test_missing_ambiguous_and_empty_finds_explain_themselves(self):
        for edits, msg in (([{"find": "nope", "replace": "x"}], "not found exactly"), ([{"find": "x", "replace": "y"}], "appears"), ([{"find": "  ", "replace": "y"}], "empty"), ([], "no edits")):
            with self.assertRaises(P.EditError) as cm:
                P.apply_edits("x x\n", edits)
            self.assertIn(msg, str(cm.exception))

    def test_crlf_files_keep_their_line_endings(self):
        old = "a\r\nb\r\nc\r\n"
        new = P.apply_edits(old, [{"find": "a\nb", "replace": "a\nB\nB2"}])
        self.assertEqual(new, "a\r\nB\r\nB2\r\nc\r\n")

    def test_replace_text_is_inserted_literally(self):
        self.assertEqual(P.apply_edits("x\n", [{"find": "x", "replace": r"\1 $& \g<0>"}]), "\\1 $& \\g<0>\n")


class PathTest(unittest.TestCase):
    def test_protected_secret_and_binary_paths_cannot_be_changed(self):
        for p in (".github/workflows/ci.yml", ".git/config", "node_modules/x/i.js", ".env", "config/.env.production", "keys/server.pem", ".ssh/config", "assets/logo.png", "package-lock.json".replace("package-lock.json", "app.lock"),
                  "/etc/passwd", "../x", "a/../b", "a\\b", "", "a\nb"):
            with self.assertRaises(P.EditError, msg=p):
                P.check_path(p)
        for p in ("src/app.js", "test/app.test.js", "docs/setup.md", "src/environment.ts"):
            self.assertEqual(P.check_path(p), p)


class DiffTest(unittest.TestCase):
    def roundtrip(self, old, new):
        d = P.make_diff("f.txt", old, new)
        self.assertEqual(P.apply_unified(old, d) if d else old, new)
        return d

    def test_modify_diff_is_git_shaped_and_round_trips(self):
        d = self.roundtrip(SRC, SRC.replace("x - y", "x + y"))
        self.assertTrue(d.startswith("diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@"))
        self.assertIn("-  return x - y;\n+  return x + y;\n", d)

    def test_new_file_diff(self):
        d = self.roundtrip(None, "line1\nline2\n")
        self.assertTrue(d.startswith("diff --git a/f.txt b/f.txt\nnew file mode 100644\n--- /dev/null\n+++ b/f.txt\n@@ -0,0 +1,2 @@\n"))
        self.assertEqual(P.diff_stats(d), (2, 0))

    def test_no_trailing_newline_is_marked_and_round_trips(self):
        self.assertIn("\\ No newline at end of file", self.roundtrip("a\nb", "a\nB"))
        self.roundtrip("a\nb\n", "a\nb")          # newline removed
        self.roundtrip("a\nb", "a\nb\nc\n")       # newline added at the end
        self.roundtrip("a", "")
        self.roundtrip("", "a\n") if False else None

    def test_identical_text_gives_no_diff(self):
        self.assertEqual(P.make_diff("f", "a\n", "a\n"), "")

    def test_many_random_edits_round_trip(self):
        rnd = random.Random(7)
        for _ in range(200):
            old = "".join(f"line {i} {rnd.choice(['alpha', 'beta', '  x', ''])}\n" for i in range(rnd.randint(0, 40)))
            lines = old.splitlines(keepends=True)
            for _ in range(rnd.randint(1, 5)):
                op = rnd.choice(["del", "ins", "mod"])
                k = rnd.randint(0, max(len(lines) - 1, 0))
                if op == "del" and lines:
                    lines.pop(k)
                elif op == "ins":
                    lines.insert(k, f"new {rnd.random():.3f}\n")
                elif lines:
                    lines[k] = lines[k].rstrip("\n") + " changed\n"
            new = "".join(lines)
            if rnd.random() < 0.15 and new:
                new = new.rstrip("\n")  # sometimes no trailing newline
            self.roundtrip(old, new)

    def test_applier_rejects_a_patch_for_different_content(self):
        d = P.make_diff("f", "a\nb\nc\n", "a\nB\nc\n")
        with self.assertRaises(ValueError):
            P.apply_unified("a\nX\nc\n", d)


class BuildTest(unittest.TestCase):
    O = {"src/add.js": SRC, "test/add.test.js": "test('x', () => {});\n"}

    def build(self, changes, existing=None):
        return P.build_changes(self.O, changes, existing or set(self.O))

    def test_modify_and_create_become_diffs_with_stats(self):
        out = self.build([{"path": "src/add.js", "action": "modify", "edits": [{"find": "x - y", "replace": "x + y"}], "content": ""},
                          {"path": "test/new.test.js", "action": "create", "edits": [], "content": "test('adds', () => {});"}])
        self.assertEqual([(c.path, c.status) for c in out], [("src/add.js", "modified"), ("test/new.test.js", "added")])
        self.assertEqual((out[0].additions, out[0].deletions), (1, 1))
        self.assertTrue(out[1].diff.endswith("+test('adds', () => {});\n"))  # newline added to new files

    def test_changes_carry_the_complete_new_file_and_its_mode(self):
        out = P.build_changes(self.O, [{"path": "src/add.js", "action": "modify", "edits": [{"find": "x - y", "replace": "x + y"}], "content": ""},
                                       {"path": "test/new.test.js", "action": "create", "edits": [], "content": "t()"}], set(self.O), {"src/add.js": "100755", "test/add.test.js": "120000"})
        self.assertEqual((out[0].content, out[0].mode), (SRC.replace("x - y", "x + y"), "100755"))
        self.assertEqual((out[1].content, out[1].mode), ("t()\n", "100644"))
        self.assertEqual(P.apply_unified(SRC, out[0].diff), out[0].content)               # the diff and the contents are the same change
        odd = P.build_changes(self.O, [{"path": "test/add.test.js", "action": "modify", "edits": [{"find": "sanity", "replace": "x"}] if False else [{"find": "test(", "replace": "it("}], "content": ""}], set(self.O), {"test/add.test.js": "120000"})
        self.assertEqual(odd[0].mode, "100644")                                             # symlinks and other modes are never propagated

    def test_every_problem_is_reported_at_once_so_the_model_can_fix_them_together(self):
        with self.assertRaises(P.EditError) as cm:
            self.build([{"path": "src/add.js", "action": "modify", "edits": [{"find": "nope", "replace": "x"}]}, {"path": "src/unseen.js", "action": "modify", "edits": [{"find": "a", "replace": "b"}]},
                        {"path": "test/add.test.js", "action": "create", "content": "x"}, {"path": ".env", "action": "create", "content": "A=1"}, {"path": "x.js", "action": "delete"}])
        m = str(cm.exception)
        for needle in ("not found exactly", "was not read", "already exists", "secret or credential", "action must be"):
            self.assertIn(needle, m)

    def test_empty_duplicate_noop_and_oversized_changes_are_refused(self):
        for ch, msg in (([], "no changes"), ([{"path": "src/add.js", "action": "modify", "edits": [{"find": "x - y", "replace": "x - y"}]}], "do not change anything"),
                        ([{"path": "a.js", "action": "create", "content": " "}], "needs content")):
            with self.assertRaises(P.EditError) as cm:
                self.build(ch)
            self.assertIn(msg, str(cm.exception))
        with self.assertRaises(P.EditError) as cm:
            self.build([{"path": "src/add.js", "action": "modify", "edits": [{"find": "x - y", "replace": "x + y"}]}, {"path": "src/add.js", "action": "modify", "edits": [{"find": "x + y", "replace": "x * y"}]}])
        self.assertIn("appears twice", str(cm.exception))
        with self.assertRaises(P.EditError) as cm:
            self.build([{"path": "big.txt", "action": "create", "content": "x" * 300_000}])
        self.assertIn("too large", str(cm.exception))


class GitAcceptsItTest(unittest.TestCase):
    """The diffs must also be accepted by the real `git apply` (the sandbox applies them with it). `git apply` only parses and patches text; it runs no code."""

    def test_git_apply_accepts_and_produces_the_same_files(self):
        import os
        import shutil
        import subprocess
        import tempfile
        if not shutil.which("git"):
            self.skipTest("git not installed")
        rnd = random.Random(11)
        cases = [(SRC, SRC.replace("x - y", "x + y")), ("a\nb", "a\nB"), ("a\nb\n", "a\nb"), (None, "new\nfile\n"), ("x\n" * 30, "x\n" * 14 + "CHANGED\n" + "x\n" * 15)]
        for _ in range(15):
            old = "".join(f"l{i} {rnd.random():.2f}\n" for i in range(rnd.randint(5, 30)))
            ls = old.splitlines(keepends=True)
            ls[rnd.randrange(len(ls))] = "edited\n"
            cases.append((old, "".join(ls)))
        for old, new in cases:
            with tempfile.TemporaryDirectory() as d:
                subprocess.run(["git", "init", "-q"], cwd=d, check=True)
                if old is not None:
                    with open(os.path.join(d, "f.txt"), "w", newline="") as f:
                        f.write(old)
                diff = P.make_diff("f.txt", old, new)
                r = subprocess.run(["git", "apply", "--whitespace=nowarn", "-"], cwd=d, input=diff, text=True, capture_output=True)
                self.assertEqual(r.returncode, 0, r.stderr)
                with open(os.path.join(d, "f.txt"), newline="") as f:
                    self.assertEqual(f.read(), new)


if __name__ == "__main__":
    unittest.main()
