"""Specialist agents (docs/04 §7). Each returns reviewable deliverables; nothing here acts irreversibly.

AGENTS_MODE=mock produces deterministic offline deliverables so the whole flow can be exercised without an LLM key.
Any other value (default) calls the LLM gateway.
"""
import os
import re
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from llm import complete_json, complete_text, sanitize_label

AgentName = Literal["research", "marketing", "designer", "communication", "code"]
ArtifactType = Literal["markdown", "image", "pdf", "video", "diff", "link", "file", "email_draft"]

MAX_DEPTH = 2          # consultation depth (PRD F8.3)
MAX_CONSULTATIONS = 4  # per task
CONSULT_OPTIONS = {
    "research": [],
    "marketing": ["research"],
    "designer": ["marketing", "research"],
    "communication": ["research"],
    "code": ["research"],
}
PERSONA = {
    "research": "a research analyst who writes clear, sourced reports",
    "marketing": "a marketing strategist who writes go-to-market plans and positioning",
    "designer": "a product designer who writes concise design briefs",
    "communication": "a communications specialist who drafts emails and messages",
    "code": "a senior engineer who writes implementation plans (you do not change repositories)",
}


class TaskIn(BaseModel):
    title: str = Field(max_length=300)
    description: str | None = Field(default=None, max_length=4000)
    due_date: str | None = None
    assignee: str | None = None


class CtxItem(BaseModel):
    label: str = Field(max_length=300)
    text: str = Field(max_length=2000)


class Feedback(BaseModel):
    comment: str | None = Field(default=None, max_length=4000)
    line_comments: list[dict] = Field(default_factory=list, max_length=50)
    previous_summary: str | None = Field(default=None, max_length=4000)


class RunRequest(BaseModel):
    task: TaskIn
    context: list[CtxItem] = Field(default_factory=list, max_length=12)
    feedback: Feedback | None = None
    revision: int = Field(default=0, ge=0, le=3)


class ArtifactOut(BaseModel):
    type: ArtifactType
    title: str
    content: str | None = None
    payload: dict | None = None


class Consultation(BaseModel):
    from_agent: str
    to_agent: str
    question: str
    answer: str
    depth: int


class RunResponse(BaseModel):
    summary: str
    notes: str = ""
    artifacts: list[ArtifactOut]
    consultations: list[Consultation] = Field(default_factory=list)


class _State:
    """Per-run consultation budget: at most 4 consults, depth <= 2, and an agent never appears twice in a call stack."""

    def __init__(self) -> None:
        self.consultations: list[Consultation] = []

    def can_consult(self, stack: list[str], target: str) -> bool:
        return len(self.consultations) < MAX_CONSULTATIONS and len(stack) < MAX_DEPTH and target not in stack


def _ctx_block(ctx: list[CtxItem]) -> str:
    return "\n".join(
        f'<untrusted_source label="{sanitize_label(c.label)}">{c.text.replace("<", " ").replace(">", " ")}</untrusted_source>' for c in ctx
    ) or "(no project context found)"


def _task_block(req: RunRequest) -> str:
    t = req.task
    parts = [f"Task: {t.title}"]
    if t.description:
        parts.append(f"Spoken in the meeting: {t.description}")
    if t.due_date:
        parts.append(f"Due: {t.due_date}")
    if t.assignee:
        parts.append(f"Assigned to: {t.assignee}")
    if req.feedback and (req.feedback.comment or req.feedback.line_comments):
        parts.append(f"\nThis is revision {req.revision}. The reviewer asked for changes: {req.feedback.comment or ''}")
        if req.feedback.line_comments:
            parts.append(f"Line comments: {req.feedback.line_comments}")
        if req.feedback.previous_summary:
            parts.append(f"Your previous summary: {req.feedback.previous_summary}")
    return "\n".join(parts)


# ---------------------------------------------------------------- mock mode
def _mock_consult_answer(to: str, question: str) -> str:
    return f"[{to}] Key points for “{question[:80]}”: focus on the primary audience, one clear message, and two measurable goals."


def _mock_run(name: str, req: RunRequest, state: _State) -> RunResponse:
    t = req.task
    rev = f" (revision {req.revision})" if req.revision else ""
    addressed = f"\n\n> Addressed reviewer feedback: {req.feedback.comment}" if req.feedback and req.feedback.comment else ""
    sources = "\n".join(f"- {c.label}" for c in req.context) or "- none found"
    if name == "designer" and state.can_consult([name], "marketing"):
        q = f"Which audience and trends matter for: {t.title}?"
        state.consultations.append(Consultation(from_agent=name, to_agent="marketing", question=q, answer=_mock_consult_answer("marketing", q), depth=1))
    consult_md = "".join(f"\n\n**Input from {c.to_agent}:** {c.answer}" for c in state.consultations)
    if name == "communication":
        body = f"Hi,\n\nFollowing up on: {t.title}.{addressed}\n\nBest regards"
        arts = [ArtifactOut(type="email_draft", title="Email draft", payload={
            "to": [], "cc": [], "subject": t.title, "body": body, "missing_recipients": True,
            "open_questions": ["Who should receive this email?"], "sources": [c.label for c in req.context]})]
        return RunResponse(summary=f"Drafted an email for “{t.title}”{rev}.", notes="No recipient was mentioned; please add one before sending.", artifacts=arts, consultations=state.consultations)
    md = f"# {name.title()} deliverable: {t.title}{rev}\n\n## Summary\nMock {name} output for the task above.{addressed}{consult_md}\n\n## Sources\n{sources}\n"
    arts = [ArtifactOut(type="markdown", title=f"{name.title()} report" if name != "code" else "Implementation plan", content=md)]
    if name == "designer":
        svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" fill="#1b2330"/>'
               f'<rect x="20" y="20" width="280" height="30" rx="6" fill="#6c8cff"/><text x="30" y="40" fill="#fff" font-size="14" font-family="sans-serif">{_esc(t.title[:34])}</text>'
               '<rect x="20" y="64" width="130" height="96" rx="6" fill="#2a3446"/><rect x="170" y="64" width="130" height="96" rx="6" fill="#2a3446"/></svg>')
        arts.append(ArtifactOut(type="image", title="Concept sketch", payload={"mime": "image/svg+xml", "svg": svg}))
    return RunResponse(summary=f"{name.title()} agent finished “{t.title}”{rev}.", notes="Generated in mock mode.", artifacts=arts, consultations=state.consultations)


def _esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# ---------------------------------------------------------------- real mode
async def _consult(frm: str, to: str, question: str, req: RunRequest, state: _State, stack: list[str]) -> None:
    if not state.can_consult(stack, to):
        return
    answer = await complete_text(
        f"You are {PERSONA[to]}. A colleague ({frm}) asks for input. Answer in at most 6 sentences.",
        f"Question: {question}\n\nProject context:\n{_ctx_block(req.context)}",
        max_tokens=600,
    )
    state.consultations.append(Consultation(from_agent=frm, to_agent=to, question=question[:500], answer=answer[:2000], depth=len(stack)))


async def _real_run(name: str, req: RunRequest, state: _State) -> RunResponse:
    task = _task_block(req)
    ctx = _ctx_block(req.context)
    options = CONSULT_OPTIONS[name]
    if options:  # ask whether another specialist's input is needed (agents help each other)
        plan = await complete_json(
            f"You are {PERSONA[name]}. Decide whether you need input from another specialist before starting. "
            f'Options: {options}. Return {{"consult":[{{"agent":"<option>","question":"<specific question>"}}]}} (empty list if none needed).',
            f"{task}\n\nProject context:\n{ctx}", max_tokens=400)
        for item in (plan.get("consult") or [])[:MAX_CONSULTATIONS]:
            if isinstance(item, dict) and item.get("agent") in options and isinstance(item.get("question"), str):
                await _consult(name, item["agent"], item["question"], req, state, [name])
    consulted = "".join(f"\nInput from {c.to_agent}: {c.answer}" for c in state.consultations)

    if name == "communication":
        data = await complete_json(
            "You draft emails. NEVER invent email addresses: only use addresses present in the task or sources; otherwise leave `to` empty and set "
            'missing_recipients=true. Return {"to":[],"cc":[],"subject":"","body":"","missing_recipients":bool,"open_questions":[],"summary":""}.',
            f"{task}\n\nProject context:\n{ctx}{consulted}", max_tokens=1500)
        body = str(data.get("body", ""))[:50000]
        payload = {"to": [str(x) for x in data.get("to", [])][:10], "cc": [str(x) for x in data.get("cc", [])][:10], "subject": str(data.get("subject", req.task.title))[:300],
                   "body": body, "missing_recipients": bool(data.get("missing_recipients", not data.get("to"))),
                   "open_questions": [str(x) for x in data.get("open_questions", [])][:5], "sources": [c.label for c in req.context]}
        return RunResponse(summary=str(data.get("summary") or f"Drafted an email for “{req.task.title}”.")[:500],
                           notes="Check recipients before sending." if payload["missing_recipients"] else "", artifacts=[ArtifactOut(type="email_draft", title="Email draft", payload=payload)], consultations=state.consultations)

    kind = {"research": "a sourced research report", "marketing": "a go-to-market / strategy plan", "designer": "a design brief", "code": "an implementation plan (files, steps, risks, tests)"}[name]
    md = await complete_text(
        f"You are {PERSONA[name]}. Produce {kind} in Markdown with a short summary at the top and a Sources section citing the labels you used.",
        f"{task}\n\nProject context:\n{ctx}{consulted}", max_tokens=3500)
    arts = [ArtifactOut(type="markdown", title="Implementation plan" if name == "code" else f"{name.title()} deliverable", content=md)]
    if name == "designer":
        svg = await complete_text("Produce ONE self-contained SVG concept sketch (viewBox 0 0 320 180, no scripts, no external links). Output only the <svg> element.",
                                  f"{task}\n\nBrief:\n{md[:1500]}", max_tokens=2500)
        m = re.search(r"<svg[\s\S]*</svg>", svg)
        if m and not re.search(r"<script|on\w+\s*=|href\s*=\s*[\"']https?:", m.group(0), re.I):
            arts.append(ArtifactOut(type="image", title="Concept sketch", payload={"mime": "image/svg+xml", "svg": m.group(0)}))
    first = next((ln.lstrip("# ").strip() for ln in md.splitlines() if ln.strip()), req.task.title)
    return RunResponse(summary=first[:300], notes="", artifacts=arts, consultations=state.consultations)


def build_router(require_secret) -> APIRouter:
    r = APIRouter(dependencies=[Depends(require_secret)])

    @r.post("/agents/{name}/run", response_model=RunResponse)
    async def run(name: AgentName, req: RunRequest) -> RunResponse:
        state = _State()
        if os.environ.get("AGENTS_MODE") == "mock":
            return _mock_run(name, req, state)
        try:
            return await _real_run(name, req, state)
        except (KeyError, TypeError, ValueError) as e:
            raise HTTPException(status_code=502, detail=f"agent output invalid: {e}") from e

    return r
