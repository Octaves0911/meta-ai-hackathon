"""Edits -> unified diff, done by code (docs/09 §2.5). Models are unreliable at writing exact line numbers, so the model proposes EXACT-TEXT edits
({find, replace}) or whole new files; this module applies them to the real file contents and generates a git-compatible unified diff itself.
`apply_unified` is a pure-Python applier used to prove the generated diffs round-trip (the real `git apply` runs in the sandbox)."""
import difflib
import re
from dataclasses import dataclass

MAX_DIFF_BYTES = 250_000
BLOCKED_DIRS = re.compile(r"(^|/)(\.git|\.github/workflows|node_modules)(/|$)", re.I)
BINARY_EXT = re.compile(r"\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|woff2?|ttf|eot|mp[34]|mov|exe|dll|so|dylib|bin|class|jar|wasm|lock)$", re.I)
SECRET = re.compile(r"(^|/)(\.env(\..*)?|\.npmrc|\.pypirc|\.netrc|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\.[a-z]+)?|secrets?(\.[a-z]+)?|.*\.(pem|key|p12|pfx|jks|keystore))$|(^|/)\.(ssh|aws|gnupg|kube|docker)(/|$)", re.I)


class EditError(ValueError):
    """An edit cannot be applied exactly; the message is fed back to the model."""


def check_path(path: str) -> str:
    """A repository-relative, non-secret, non-binary path the agent may change. Returns the path or raises EditError."""
    if not isinstance(path, str) or not path or len(path) > 300 or path.startswith("/") or re.search(r"[\0\r\n\\]", path) or any(s in ("", ".", "..") for s in path.split("/")):
        raise EditError(f"“{str(path)[:80]}” is not a valid repository path")
    if SECRET.search(path):
        raise EditError(f"{path} looks like a secret or credential file and cannot be changed")
    if BLOCKED_DIRS.search(path):
        raise EditError(f"{path} is in a protected location (CI workflows, .git, node_modules) and cannot be changed by an agent")
    if BINARY_EXT.search(path):
        raise EditError(f"{path} is a binary or generated file type and cannot be edited as text")
    return path


def _eol(text: str) -> str:
    return "\r\n" if "\r\n" in text else "\n"


def apply_edits(old: str, edits: list[dict]) -> str:
    """Apply exact-text edits in order. Each `find` must appear exactly once (in the text as edited so far)."""
    if not edits:
        raise EditError("no edits were given")
    eol = _eol(old)
    text = old
    for i, e in enumerate(edits, 1):
        find, rep = str(e.get("find", "")), str(e.get("replace", ""))
        if eol == "\r\n":
            find, rep = find.replace("\r\n", "\n").replace("\n", "\r\n"), rep.replace("\r\n", "\n").replace("\n", "\r\n")
        if not find.strip():
            raise EditError(f"edit {i}: the text to replace is empty")
        n = text.count(find)
        if n == 0:
            raise EditError(f"edit {i}: the text to replace was not found exactly (whitespace and indentation must match): {find[:100]!r}")
        if n > 1:
            raise EditError(f"edit {i}: the text to replace appears {n} times; include more surrounding lines so it is unique: {find[:100]!r}")
        text = text.replace(find, rep, 1)
    return text


def make_diff(path: str, old: str | None, new: str) -> str:
    """git-compatible unified diff for one file. old=None means a new file."""
    a = [] if old is None else old.splitlines(keepends=True)
    b = new.splitlines(keepends=True)
    head = [f"diff --git a/{path} b/{path}\n"] + (["new file mode 100644\n"] if old is None else [])
    body = list(difflib.unified_diff(a, b, "/dev/null" if old is None else f"a/{path}", f"b/{path}", n=3, lineterm="\n"))
    if not body:
        return ""
    out = []
    for ln in body:
        out.append(ln if ln.endswith("\n") else ln + "\n\\ No newline at end of file\n")
    # difflib terminates ---/+++ and @@ lines with lineterm; content lines without a trailing newline get the marker above
    return "".join(head + out)


@dataclass
class FileChange:
    path: str
    status: str            # "modified" | "added"
    additions: int
    deletions: int
    diff: str
    content: str = ""          # the complete new file text: what a pull request commits (exactly what was verified)
    mode: str = "100644"      # git file mode, kept so an executable stays executable


def diff_stats(diff: str) -> tuple[int, int]:
    add = sum(1 for l in diff.splitlines() if l.startswith("+") and not l.startswith("+++"))
    dele = sum(1 for l in diff.splitlines() if l.startswith("-") and not l.startswith("---"))
    return add, dele


def build_changes(originals: dict[str, str], changes: list[dict], existing: set[str], modes: dict[str, str] | None = None) -> list[FileChange]:
    """Turn the model's change list into file diffs. `originals` holds the contents of every file it was allowed to see. Raises EditError with ALL problems."""
    problems: list[str] = []
    out: list[FileChange] = []
    seen: set[str] = set()
    for ch in changes:
        try:
            path = check_path(ch.get("path", ""))
            if path in seen:
                raise EditError(f"{path} appears twice; give all edits for a file together")
            seen.add(path)
            action = ch.get("action")
            if action == "modify":
                if path not in originals:
                    raise EditError(f"{path} was not read, so it cannot be modified safely; only files you were shown can be edited")
                new = apply_edits(originals[path], ch.get("edits") or [])
                diff = make_diff(path, originals[path], new)
                if not diff:
                    raise EditError(f"{path}: the edits do not change anything")
                add, dele = diff_stats(diff)
                out.append(FileChange(path, "modified", add, dele, diff, new, (modes or {}).get(path, "100644") if (modes or {}).get(path) in ("100644", "100755") else "100644"))
            elif action == "create":
                if path in existing or path in originals:
                    raise EditError(f"{path} already exists; modify it with edits instead of creating it")
                content = str(ch.get("content", ""))
                if not content.strip():
                    raise EditError(f"{path}: a new file needs content")
                if not content.endswith("\n"):
                    content += "\n"
                diff = make_diff(path, None, content)
                add, dele = diff_stats(diff)
                out.append(FileChange(path, "added", add, dele, diff, content, "100644"))
            else:
                raise EditError(f"{path}: action must be 'modify' or 'create'")
        except EditError as e:
            problems.append(str(e))
    if problems:
        raise EditError("; ".join(problems))
    if not out:
        raise EditError("no changes were proposed")
    if sum(len(c.diff.encode()) for c in out) > MAX_DIFF_BYTES:
        raise EditError("the change is too large; keep it focused on what the task asks")
    return out


# ---------------------------------------------------------------- pure-Python applier (tests / sanity checks only)
def apply_unified(old: str | None, diff: str) -> str:
    """Apply a one-file unified diff produced by make_diff. Raises ValueError if a context or removed line does not match."""
    lines = [] if old is None else old.splitlines(keepends=True)
    out: list[str] = []
    i = 0
    hunks = re.split(r"(?m)^(?=@@ )", diff)[1:]
    for h in hunks:
        m = re.match(r"@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@", h)
        if not m:
            raise ValueError("bad hunk header")
        start, count = int(m.group(1)), int(m.group(2) if m.group(2) is not None else 1)
        start0 = start - 1 if count else start
        out += lines[i:start0]
        i = start0
        last = None  # which side the previous body line belonged to: "old", "new" or "both"
        for l in h.splitlines(keepends=True)[1:]:
            if l.startswith("\\"):
                if last in ("new", "both") and out:
                    out[-1] = out[-1].rstrip("\n")
                continue
            tag, body = l[0], l[1:]
            if tag == " ":
                if i >= len(lines) or lines[i].rstrip("\n") != body.rstrip("\n"):
                    raise ValueError(f"context mismatch at line {i + 1}")
                out.append(lines[i] if not body.endswith("\n") or lines[i].endswith("\n") else body)
                i += 1
                last = "both"
            elif tag == "-":
                if i >= len(lines) or lines[i].rstrip("\n") != body.rstrip("\n"):
                    raise ValueError(f"removed line mismatch at line {i + 1}")
                i += 1
                last = "old"
            elif tag == "+":
                out.append(body)
                last = "new"
    out += lines[i:]
    return "".join(out)
