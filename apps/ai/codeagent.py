"""Code agent (docs/09 §2.5), level 2: a reviewed, VERIFIED change to one of the project's GitHub repositories. Never applied automatically.

  1 choose the repository (reviewer's choice wins; otherwise the repo picker; unsure -> the reviewer decides, nothing is guessed)
  2 read the file list and the files that matter, through the connector (secrets are refused there)
  3 the model proposes EXACT-TEXT edits and new files; CODE applies them and generates the unified diff
  4 the diff is verified in the Modal sandbox (install with limited network, then tests with none); failures are fed back for up to two repairs
  5 deliver: plan, diff, verification evidence. A change that was not actually tested is labelled 'not tested', never 'verified'."""
import asyncio
import os
from dataclasses import asdict

from agents import ArtifactOut, RunRequest, RunResponse, _State, _task_block
from githubread import GithubReadError, clone_token, file as read_file, tree as read_tree
from llm import add_cost, agent_model, chat_json
from patching import EditError, FileChange, build_changes
from quality import self_check
from repo_picker import PickRequest, RepoIn, pick_repo
from runtrace import Trace
from sandbox import RepoSource, SandboxError, Verification, get_backend, verify_change

MAX_READ_FILES = 12
MAX_FILE_CHARS = 30_000
MAX_TOTAL_CHARS = 120_000
MAX_TREE_LISTED = 500
MAX_EDIT_ATTEMPTS = 3        # the model's first try plus two corrections of edits that do not apply exactly
MAX_VERIFY_REPAIRS = 2       # corrections after a failed verification

LOCATE_SCHEMA = {
    "type": "object",
    "properties": {"files": {"type": "array", "items": {"type": "string"}}, "why": {"type": "string"}},
    "required": ["files", "why"], "additionalProperties": False,
}
CHANGE_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"}, "steps": {"type": "array", "items": {"type": "string"}}, "risks": {"type": "array", "items": {"type": "string"}},
        "tests": {"type": "array", "items": {"type": "string"}}, "rollout": {"type": "string"},
        "changes": {"type": "array", "items": {"type": "object", "properties": {
            "path": {"type": "string"}, "action": {"type": "string", "enum": ["modify", "create"]},
            "edits": {"type": "array", "items": {"type": "object", "properties": {"find": {"type": "string"}, "replace": {"type": "string"}}, "required": ["find", "replace"], "additionalProperties": False}},
            "content": {"type": "string"}}, "required": ["path", "action", "edits", "content"], "additionalProperties": False}},
    },
    "required": ["summary", "steps", "risks", "tests", "rollout", "changes"], "additionalProperties": False,
}

LOCATE_RULES = (
    "You are a senior engineer about to implement a task in an existing repository. From the task, what was said in the meeting and the repository file list, choose up to 12 files you must READ: "
    "the files to change, plus an existing test file and any config you should imitate. Choose only paths that appear in the list. Prefer a small, focused set."
)
CHANGE_RULES = (
    "You implement the task as a minimal, focused change to the repository, using ONLY the files shown. Output `changes`: for an existing file use action 'modify' with `edits`, each edit's `find` being an EXACT, UNIQUE snippet "
    "copied from the file shown (several lines, indentation preserved) and `replace` its replacement (content ''); for a new file use action 'create' with the full `content` (edits []). "
    "Add or update tests in the repository's existing test style and framework so the new behaviour is covered: a test that fails without your change and passes with it. "
    "Do not touch CI, lockfiles, credentials or unrelated files; do not reformat or rename code you do not need to change; never invent APIs that are not visible in the files. "
    "If the task cannot be done safely from what you can see, return an empty `changes` list and say why in `summary`. Also give the plan: summary, steps, risks, tests (what the tests check) and rollout."
)


def _fence(label: str, text: str) -> str:
    return f'<untrusted_source label="{label}">{text.replace("<", " ").replace(">", " ")}</untrusted_source>'


def render_files(files: dict[str, str]) -> str:
    return "\n\n".join(f"File {p}:\n{_fence(p, t)}" for p, t in files.items())


def verification_payload(v: Verification, mode: str, repo: RepoIn, branch: str) -> dict:
    return {"status": v.status, "reason": v.reason, "ecosystem": v.ecosystem, "mode": mode, "repo": repo.full_name, "branch": branch, "seconds": v.seconds, "cost_usd": v.cost_usd,
            "red_exit": v.red_exit, "green_exit": v.green_exit, "warnings": v.warnings, "summary": v.summary(),
            "steps": [{"phase": s.phase, "label": s.label, "exit_code": s.exit_code, "seconds": s.seconds, "timed_out": s.timed_out, "output": s.output[-4000:], "counts": s.counts} for s in v.steps]}


def _mode() -> str:
    m = os.environ.get("SANDBOX_MODE", "").lower()
    return m or ("modal" if os.environ.get("MODAL_TOKEN_ID") else "off")


def plan_markdown(title: str, repo: RepoIn, branch: str, plan: dict, changes: list[FileChange], v: Verification) -> str:
    rows = "\n".join(f"| {c.path} | {c.status} | +{c.additions} −{c.deletions} |" for c in changes)
    parts = [f"# Code change: {title}", f"## Summary\n{plan.get('summary', '').strip()}", f"## Repository\n{repo.full_name} (base branch `{branch}`)"]
    if changes:
        parts.append("## Files changed\n| File | Change | Lines |\n|---|---|---|\n" + rows)
    if plan.get("steps"):
        parts.append("## Steps\n" + "\n".join(f"{i}. {s}" for i, s in enumerate(plan["steps"], 1)))
    if plan.get("tests"):
        parts.append("## Tests\n" + "\n".join(f"- {t}" for t in plan["tests"]))
    ver = {"verified": "✔ Verified in an isolated sandbox: the tests ran and passed.", "failed": f"✘ Failed verification: {v.reason}", "not_tested": f"Not tested: {v.reason}"}[v.status]
    parts.append("## Verification\n" + ver + ("".join(f"\n- Warning: {w}" for w in v.warnings)))
    if plan.get("risks"):
        parts.append("## Risks\n" + "\n".join(f"- {r}" for r in plan["risks"]))
    if plan.get("rollout"):
        parts.append(f"## Rollout\n{plan['rollout']}")
    return "\n\n".join(parts)


async def _plan_only(req: RunRequest, state: _State, trace: Trace, reason: str, extra_q: list[str] | None = None, repo_id: str | None = None) -> RunResponse:
    """No usable repository: the L1 plan only (steps, files likely touched, risks, tests), clearly labelled."""
    from agents import _draft_text  # lazy: agents imports this module

    model = agent_model("code")
    async with trace.step("draft", "Write an implementation plan (no repository available)"):
        md = await _draft_text("code", _task_block(req), "", model)
    async with trace.step("check", "Self-check the plan") as st:
        check = await self_check("code", _task_block(req), md, model=model)
        st["detail"]["blocking"] = check.blocking
    note = f"Plan only: {reason}"
    arts = [ArtifactOut(type="markdown", title="Implementation plan", content=f"> {note}\n\n{md}")]
    first = next((ln.lstrip("# ").strip() for ln in md.splitlines() if ln.strip()), req.task.title)
    return RunResponse(summary=first[:300], notes=note, artifacts=arts, consultations=state.consultations, confidence=round(check.confidence * 0.6, 2), repo_id=repo_id,
                       open_questions=[reason, *(extra_q or []), *check.open_questions][:6])


async def run_code(req: RunRequest, state: _State, trace: Trace) -> RunResponse:
    model = agent_model("code")
    task = _task_block(req)
    mode = _mode()
    async with trace.step("read", "Read the brief", {"repos": len(req.repos), "sandbox": mode}):
        pass

    # 1. which repository?
    repo: RepoIn | None = None
    async with trace.step("plan", "Choose the repository") as st:
        if req.repo_id:
            repo = next((r for r in req.repos if r.id == req.repo_id), None)
            st["detail"]["decision"] = "chosen by the reviewer" if repo else "chosen repository no longer linked"
        if repo is None:
            brief_fields = {k: getattr(req, k) for k in ("task", "context", "meeting", "quote", "source_lines", "decisions", "neighbours", "prior_work", "brand_note")}
            pick = await pick_repo(PickRequest(**brief_fields, repos=req.repos))
            st["detail"].update({"decision": pick.decision, "confidence": pick.confidence})
            if pick.decision == "pick":
                repo = next(r for r in req.repos if r.id == pick.repo_id)
            elif pick.decision == "ambiguous":
                return RunResponse(summary="Which repository should this change go to?", notes="More than one linked repository could be right. Choose one and the agent will continue.", artifacts=[],
                                   consultations=state.consultations, confidence=None, open_questions=["Which repository should this change go to?"],
                                   repo_choice={"candidates": [c.model_dump() for c in pick.candidates], "reason": pick.reason})
            else:
                reason = pick.reason
    if repo is None:
        return await _plan_only(req, state, trace, reason if "reason" in dir() else "No linked repository matches this task.")
    branch = repo.default_branch or "main"
    owner, name = repo.full_name.split("/", 1)
    pid = req.project_id or ""

    # 2. read the repository
    try:
        async with trace.step("read", f"List the files of {repo.full_name}") as st:
            tree = await read_tree(pid, owner, name, branch)
            files = [f["path"] for f in tree["files"]]
            sizes = {f["path"]: int(f.get("size", 0)) for f in tree["files"]}
            st["detail"].update({"files": len(files), "truncated": tree.get("truncated", False)})
        listing = "\n".join(f"{p} ({sizes[p]} bytes)" for p in sorted(files, key=lambda p: (p.count("/"), p))[:MAX_TREE_LISTED])
        async with trace.step("plan", "Decide which files to read") as st:
            loc = await chat_json(LOCATE_RULES, f"{task}\n\nRepository {repo.full_name}:\n{_fence('index', repo.index_text)}\n\nFiles:\n{listing}", LOCATE_SCHEMA, max_tokens=500, model=model)
            wanted = [p for p in dict.fromkeys(str(x) for x in loc.get("files", [])) if p in sizes and sizes[p] <= MAX_FILE_CHARS * 2][:MAX_READ_FILES]
            st["detail"]["files"] = wanted
        async with trace.step("read", "Read the files") as st:
            got = await asyncio.gather(*(read_file(pid, owner, name, p, branch) for p in wanted), return_exceptions=True)
            originals: dict[str, str] = {}
            total = 0
            for p, g in zip(wanted, got):
                if isinstance(g, Exception) or len(g["text"]) > MAX_FILE_CHARS or total + len(g["text"]) > MAX_TOTAL_CHARS:
                    continue
                originals[p] = g["text"]
                total += len(g["text"])
            st["detail"].update({"read": list(originals), "chars": total})
    except GithubReadError as e:
        return await _plan_only(req, state, trace, f"The repository could not be read ({e.message}).", repo_id=repo.id)
    if not originals:
        return await _plan_only(req, state, trace, "None of the relevant files could be read, so no change was proposed.", repo_id=repo.id)

    # 3. the model proposes edits; code builds the diff (corrections for edits that do not apply exactly)
    prior = ""
    if req.feedback and req.feedback.previous_output:
        prior = f"\n\nYour previous change (revise it according to the reviewer's feedback):\n{_fence('previous change', req.feedback.previous_output)}"
    changes: list[FileChange] = []
    plan: dict = {}
    problems: list[str] = []
    async with trace.step("draft", "Write the change and build the diff") as st:
        for attempt in range(MAX_EDIT_ATTEMPTS):
            fix = ("\n\nYour previous edits had these problems. Fix every one (copy `find` text exactly from the files above):\n- " + "\n- ".join(problems)) if problems else ""
            plan = await chat_json(CHANGE_RULES, f"{task}{prior}\n\nRepository {repo.full_name} (branch {branch}).\n\n{render_files(originals)}{fix}", CHANGE_SCHEMA, max_tokens=4500, model=model)
            if not plan.get("changes"):
                changes = []
                break
            try:
                changes = build_changes(originals, plan["changes"], set(files))
                problems = []
                break
            except EditError as e:
                problems = [str(e)]
                changes = []
        st["detail"].update({"attempts": attempt + 1, "files_changed": [c.path for c in changes], "problems": problems})
    if not changes:
        why = problems[0] if problems else (plan.get("summary") or "The model decided the task cannot be done safely from the files it could see.")
        return await _plan_only(req, state, trace, f"No change could be produced: {why[:300]}", repo_id=repo.id)

    # 4. verify in the sandbox; correct after a failed verification
    verification, attempts = Verification("not_tested", "The sandbox is switched off, so nothing was run."), 0
    try:
        backend = get_backend()
    except SandboxError as e:
        backend, verification = None, Verification("not_tested", f"The sandbox is not available: {e}")
    for attempt in range(MAX_VERIFY_REPAIRS + 1):
        patch = "".join(c.diff for c in changes)
        if backend is not None:
            async with trace.step("check", f"Verify the change in the sandbox (attempt {attempt + 1})") as st:
                try:
                    token = await clone_token(pid) if pid else None
                except GithubReadError:
                    token = None
                verification = await verify_change(backend, RepoSource(clone_url=f"https://github.com/{repo.full_name}.git", ref=branch, token=token), patch, patch_ref=f"`{branch}`")
                add_cost(verification.cost_usd, "sandbox_cost_usd")
                st["detail"].update({"status": verification.status, "reason": verification.reason[:200], "seconds": verification.seconds})
        attempts = attempt + 1
        if verification.status != "failed" or attempt == MAX_VERIFY_REPAIRS:
            break
        failing = next((s for s in reversed(verification.steps) if not s.ok), None)
        async with trace.step("draft", "Correct the change after the failed verification") as st:
            fix = (f"\n\nYour change FAILED verification in the sandbox: {verification.reason}\nThe failing step ({failing.label if failing else '?'}) printed:\n"
                   f"{_fence('sandbox output', (failing.output if failing else '')[-3000:])}\nCorrect the change. Return the complete corrected change set, with edits relative to the ORIGINAL files shown above.")
            for _ in range(MAX_EDIT_ATTEMPTS):
                plan2 = await chat_json(CHANGE_RULES, f"{task}\n\nRepository {repo.full_name} (branch {branch}).\n\n{render_files(originals)}{fix}", CHANGE_SCHEMA, max_tokens=4500, model=model)
                try:
                    changes = build_changes(originals, plan2.get("changes") or [], set(files))
                    plan = plan2
                    break
                except EditError as e:
                    fix += f"\n\nThat correction's edits had problems: {e}"
            else:
                break
            st["detail"]["files_changed"] = [c.path for c in changes]

    # 5. deliver
    md = plan_markdown(req.task.title, repo, branch, plan, changes, verification)
    async with trace.step("check", "Self-check the plan and the change") as st:
        patch = "".join(c.diff for c in changes)
        check = await self_check("code", task, f"{md}\n\nDiff (truncated):\n{patch[:7000]}", model=model,
                                 note="The diff is built by code from exact edits, so it is syntactically valid. The Verification section reports what the sandbox actually did; do not penalise 'not tested' (it is reported honestly). "
                                      "Flag: changes unrelated to the task, invented APIs, missing tests, ignored decisions.")
        st["detail"]["blocking"] = check.blocking
    arts = [ArtifactOut(type="markdown", title="Implementation plan", content=md),
            ArtifactOut(type="diff", title=f"Change to {repo.full_name}", payload={"diff": patch, "repo": repo.full_name, "branch": branch,
                                                                                    "files": [{"path": c.path, "status": c.status, "additions": c.additions, "deletions": c.deletions} for c in changes]}),
            ArtifactOut(type="verification", title=f"Verification: {verification.summary()}", payload=verification_payload(verification, mode, repo, branch))]
    open_q = list(check.open_questions) + [f"Confirm {b}" for b in check.blocking]
    if verification.status == "not_tested":
        open_q.append(f"This change was NOT tested: {verification.reason}")
    elif verification.status == "failed":
        open_q.append(f"The change failed verification after {attempts} attempt(s): {verification.reason}")
    open_q += verification.warnings
    factor = {"verified": 1.0, "not_tested": 0.7, "failed": 0.4}[verification.status]
    conf = check.confidence * factor * (0.6 if check.blocking else 1.0)
    notes = {"verified": "Verified in the sandbox. Review the diff before it goes anywhere.", "not_tested": "Not tested in a sandbox; review the diff carefully. A pull request is only offered for verified changes.",
             "failed": "Verification failed; the diff is shown for review but cannot become a pull request."}[verification.status]
    first = plan.get("summary") or req.task.title
    return RunResponse(summary=first[:300], notes=notes, artifacts=arts, consultations=state.consultations, confidence=round(conf, 2), repo_id=repo.id,
                       open_questions=list(dict.fromkeys(open_q))[:7])
