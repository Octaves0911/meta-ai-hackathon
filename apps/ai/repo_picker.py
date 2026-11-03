"""Repo picker (docs/09 §1.10): which of the project's linked GitHub repositories does a code task belong to? The model scores every repository from the task,
the meeting context and each repo's index; CODE makes the decision, so it can never quietly guess:
  pick       one repository is clearly the best (score >= 0.7 and 0.2 ahead of the next)
  ambiguous  several plausible: the reviewer chooses
  none       nothing fits (best < 0.4), or the task needs no repository"""
import os
import re
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from brief import BriefIn, render_brief, sanitize_label
from llm import agent_model, chat_json

PICK_MIN = 0.7
PICK_LEAD = 0.2
NONE_BELOW = 0.4
MAX_CANDIDATES = 3

SCHEMA = {
    "type": "object",
    "properties": {
        "needs_repo": {"type": "boolean"},
        "scores": {"type": "array", "items": {"type": "object", "properties": {"repo_id": {"type": "string"}, "score": {"type": "number"}, "reason": {"type": "string"}}, "required": ["repo_id", "score", "reason"], "additionalProperties": False}},
    },
    "required": ["needs_repo", "scores"], "additionalProperties": False,
}


class RepoIn(BaseModel):
    id: str = Field(max_length=64)
    full_name: str = Field(max_length=140)
    default_branch: str = Field(default="main", max_length=200)
    description: str | None = Field(default=None, max_length=300)         # written by the project owner: most trusted signal
    github_description: str | None = Field(default=None, max_length=300)
    language: str | None = Field(default=None, max_length=40)
    languages: dict[str, int] = Field(default_factory=dict)
    index_text: str = Field(default="", max_length=6500)


class PickRequest(BriefIn):
    repos: list[RepoIn] = Field(default_factory=list, max_length=10)


class Candidate(BaseModel):
    repo_id: str
    full_name: str
    score: float
    reason: str = ""


class PickOut(BaseModel):
    decision: Literal["pick", "ambiguous", "none"]
    repo_id: str | None = None
    confidence: float = 0.0
    reason: str = ""
    candidates: list[Candidate] = Field(default_factory=list)


def decide(repos: list[RepoIn], data: dict) -> PickOut:
    """Validate the model's scores against the real repository list and apply the thresholds."""
    if not repos:
        return PickOut(decision="none", reason="No repositories are linked to this project. The owner can add GitHub repositories in project settings.")
    names = {r.id: r.full_name for r in repos}
    scored: dict[str, Candidate] = {}
    for s in data.get("scores") or []:
        rid = str(s.get("repo_id", "")) if isinstance(s, dict) else ""
        if rid not in names or rid in scored:  # unknown ids are ignored: the model cannot invent a repository
            continue
        try:
            score = min(max(float(s.get("score", 0)), 0.0), 1.0)
        except (TypeError, ValueError):
            score = 0.0
        scored[rid] = Candidate(repo_id=rid, full_name=names[rid], score=round(score, 2), reason=str(s.get("reason", ""))[:240])
    ranked = sorted((scored.get(r.id) or Candidate(repo_id=r.id, full_name=r.full_name, score=0.0) for r in repos), key=lambda c: -c.score)
    best, second = ranked[0], (ranked[1].score if len(ranked) > 1 else 0.0)
    if data.get("needs_repo") is False:
        return PickOut(decision="none", reason="This task does not need a code repository.", candidates=[])
    if best.score >= PICK_MIN and (best.score - second >= PICK_LEAD):
        return PickOut(decision="pick", repo_id=best.repo_id, confidence=best.score, reason=best.reason or f"{best.full_name} fits this task best.", candidates=ranked[:MAX_CANDIDATES])
    if best.score < NONE_BELOW:
        return PickOut(decision="none", confidence=best.score, reason="None of the linked repositories clearly matches this task.", candidates=[c for c in ranked if c.score > 0][:MAX_CANDIDATES])
    plausible = [c for c in ranked if c.score >= 0.3][:MAX_CANDIDATES]
    return PickOut(decision="ambiguous", confidence=best.score, reason="More than one repository could be right; please choose.", candidates=plausible)


def render_repos(repos: list[RepoIn]) -> str:
    blocks = []
    for r in repos:
        langs = ", ".join(f"{k} {v}" for k, v in sorted(r.languages.items(), key=lambda kv: -kv[1])[:4])
        owner_desc = f"\nOwner's description: {sanitize_label(r.description, 300)}" if r.description else ""
        idx = r.index_text.replace("<", " ").replace(">", " ")
        blocks.append(f"Repository id {r.id}: {sanitize_label(r.full_name, 140)}{owner_desc}\nGitHub description: {sanitize_label(r.github_description or '', 300)}\n"
                      f"Main language: {r.language or '?'} ({langs})\n<untrusted_source label=\"index of {sanitize_label(r.full_name, 80)}\">{idx}</untrusted_source>")
    return "\n\n".join(blocks)


SYSTEM = (
    "You decide which code repository a meeting task belongs to. Score EVERY repository from 0 to 1 for how likely the task's code change belongs there, "
    "using the task title and what was said first, then each repository's name, the owner's description, its languages, top-level folders, manifests and README. "
    "The owner's description is the most reliable signal. Give a short reason per repository. Be decisive: use 0.8+ only when one repository is clearly the one; "
    "if the task is not about changing code at all (design, research, an email), set needs_repo=false. Never invent a repository id."
)


def mock_decide(req: PickRequest) -> PickOut:
    """Offline demo: word overlap between the task and each repository's name and descriptions."""
    tok = lambda s: set(re.findall(r"[a-z0-9]{3,}", s.lower()))
    task = tok(f"{req.task.title} {req.task.description or ''}")
    scores = [{"repo_id": r.id, "score": min(1.0, 0.4 + 0.3 * len(task & tok(f"{r.full_name} {r.description or ''} {r.github_description or ''}"))) if task & tok(f"{r.full_name} {r.description or ''} {r.github_description or ''}") else 0.1, "reason": "word overlap (mock)"} for r in req.repos]
    return decide(req.repos, {"needs_repo": True, "scores": scores})


async def pick_repo(req: PickRequest) -> PickOut:
    if not req.repos:
        return decide([], {})
    if os.environ.get("AGENTS_MODE") == "mock":
        return mock_decide(req)
    data = await chat_json(SYSTEM, f"{render_brief(req)}\n\nLinked repositories:\n{render_repos(req.repos)}", SCHEMA, max_tokens=900, model=agent_model("code"))
    return decide(req.repos, data)


def build_router(require_secret) -> APIRouter:
    r = APIRouter(dependencies=[Depends(require_secret)])

    @r.post("/repos/pick", response_model=PickOut)
    async def pick(req: PickRequest) -> PickOut:
        return await pick_repo(req)

    return r
