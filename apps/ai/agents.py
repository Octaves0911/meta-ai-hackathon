"""Specialist agents (docs/04 §7). Each returns reviewable deliverables; nothing here acts irreversibly.

AGENTS_MODE=mock produces deterministic offline deliverables so the whole flow can be exercised without an LLM key.
Any other value (default) calls the LLM gateway.
"""
import asyncio
import os
import re
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

import base64

from brief import BriefIn, CtxItem, TaskIn, brief_text_for_facts, render_brief, render_context  # noqa: F401  (TaskIn/CtxItem re-exported)
from llm import agent_model, begin_usage, chat_json, complete_json, complete_text, sanitize_label
from files import build_pdf, markdown_to_spec
from quality import Check, self_check, unsupported_facts
from runtrace import LimitExceeded, Trace

AgentName = Literal["research", "marketing", "designer", "communication", "code"]
ArtifactType = Literal["markdown", "image", "pdf", "video", "diff", "link", "file", "email_draft", "html", "table"]

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


class Feedback(BaseModel):
    comment: str | None = Field(default=None, max_length=4000)
    line_comments: list[dict] = Field(default_factory=list, max_length=50)
    previous_summary: str | None = Field(default=None, max_length=4000)
    previous_output: str | None = Field(default=None, max_length=12000)  # the deliverable being revised (text), so the agent edits it


WALL_CLOCK_SECONDS = 170  # per run (docs/09 §1.6); the backend's own timeout is 180 s


class RunRequest(BriefIn):
    feedback: Feedback | None = None
    revision: int = Field(default=0, ge=0, le=10)
    execution_id: str | None = None   # when set, progress steps are streamed to the backend
    callback_url: str | None = Field(default=None, max_length=200)


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
    confidence: float | None = None
    open_questions: list[str] = Field(default_factory=list)
    usage: dict = Field(default_factory=dict)
    steps: list[dict] = Field(default_factory=list)


class _State:
    """Per-run consultation budget: at most 4 consults, depth <= 2, and an agent never appears twice in a call stack."""

    def __init__(self) -> None:
        self.consultations: list[Consultation] = []

    def can_consult(self, stack: list[str], target: str) -> bool:
        return len(self.consultations) < MAX_CONSULTATIONS and len(stack) < MAX_DEPTH and target not in stack


def _ctx_block(ctx: list[CtxItem]) -> str:
    return render_context(ctx)


def _task_block(req: RunRequest) -> str:
    """The whole brief (task, meeting, what was said, decisions, neighbours, prior work, project context) plus reviewer feedback."""
    parts = [render_brief(req)]
    if req.feedback and (req.feedback.comment or req.feedback.line_comments):
        parts.append(f"This is revision {req.revision}. The reviewer asked for changes: {req.feedback.comment or ''}")
        if req.feedback.line_comments:
            parts.append(f"Line comments: {req.feedback.line_comments}")
        if req.feedback.previous_summary:
            parts.append(f"Your previous summary: {req.feedback.previous_summary}")
        if req.feedback.previous_output:
            parts.append(f"Your previous output (revise THIS):\n<untrusted_source label=\"previous output\">{req.feedback.previous_output.replace('<', ' ').replace('>', ' ')}</untrusted_source>")
        parts.append("Edit your previous work to address this; keep everything the reviewer did not object to unchanged.")
    return "\n\n".join(parts)


# ---------------------------------------------------------------- email helpers
_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")


def _allowed_emails(req: "RunRequest") -> set[str]:
    """Addresses the agent may use: those in the task itself or in the sources. Everything else is invented and dropped."""
    found = set(_EMAIL.findall(f"{req.task.title} {req.task.description or ''} {req.quote or ''} " + " ".join(ln.text for ln in req.source_lines)))
    for c in req.context:
        found.update(_EMAIL.findall(c.text))
        if c.meta and c.meta.get("from_email"):
            found.add(str(c.meta["from_email"]))
    return {e.lower() for e in found}


def _names(req: "RunRequest") -> set[str]:
    return {w.lower() for w in re.findall(r"\b[A-Z][a-z]{2,}\b", f"{req.task.title} {req.task.description or ''}")} - {"reply", "email", "write", "send", "draft", "follow", "please"}


def _thread_source(req: "RunRequest") -> "CtxItem | None":
    """The mail (from the reviewer's own mailbox) a reply should answer: its sender is named in the task."""
    names = _names(req)
    for c in req.context:  # context is ranked, best match first
        m = c.meta or {}
        if not m.get("from_email"):
            continue
        hay = f"{c.label} {str(m['from_email']).split('@')[0]}".lower()
        if any(n in hay for n in names):
            return c
    return None


def _reply_fields(src: "CtxItem | None") -> dict:
    if not src or not src.meta:
        return {}
    subj = (src.meta.get("subject") or "").strip()
    return {
        "to": [src.meta["from_email"]] if src.meta.get("from_email") else [],
        "subject": subj if subj.lower().startswith("re:") else f"Re: {subj}" if subj else None,
        "thread_id": src.meta.get("thread_id"), "in_reply_to": src.meta.get("message_id"), "references": src.meta.get("message_id"),
    }


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
        src = _thread_source(req)
        reply = _reply_fields(src)
        to = reply.get("to") or []
        body = f"Hi,\n\nFollowing up on: {t.title}.{addressed}\n\nBest regards"
        payload = {
            "to": to, "cc": [], "subject": reply.get("subject") or t.title, "body": body, "missing_recipients": not to,
            "open_questions": [] if to else ["Who should receive this email?"], "sources": [src.label] if src else [c.label for c in req.context],
            "facts": [], "attachments": [], "suggested_attachments": [f.id for f in req.files][:1] if ATTACH_WORDS.search(f"{t.title} {t.description or ''}") else [],
            **{k: v for k, v in reply.items() if k in ("thread_id", "in_reply_to", "references") and v},
        }
        arts = [ArtifactOut(type="email_draft", title="Email draft", payload=payload)]
        return RunResponse(summary=f"Drafted {'a reply' if src else 'an email'} for “{t.title}”{rev}.",
                           notes="Replying in your existing thread." if src else "No recipient was found in your mailbox; please add one before sending.",
                           artifacts=arts, consultations=state.consultations)
    md = f"# {name.title()} deliverable: {t.title}{rev}\n\n## Summary\nMock {name} output for the task above.{addressed}{consult_md}\n\n## Sources\n{sources}\n"
    arts = [ArtifactOut(type="markdown", title=f"{name.title()} report" if name != "code" else "Implementation plan", content=md)]
    if name == "marketing":
        arts.append(ArtifactOut(type="table", title="Timeline", payload={"columns": ["Phase", "Start", "End", "Owner", "Deliverable"], "rows": [["Teaser", "Nov 8, 2026", "Nov 15, 2026", "Unassigned", "Mock teaser"], ["Launch", "Nov 22, 2026", "Nov 22, 2026", "Unassigned", "Mock launch"]]}))
    if name == "research":
        arts.append(ArtifactOut(type="link", title="Sources (1)", payload={"items": [{"title": "Example pricing page", "url": "https://example.com/pricing", "host": "example.com"}], "searched_on": "mock"}))
    if name == "designer":
        for label, bg, fg in (("A", "#0f1424", "#ffffff"), ("B", "#fbfaf7", "#1c1b19")):
            html = f'<!doctype html><html><body style="margin:0;background:{bg};color:{fg};font-family:sans-serif"><div style="padding:40px"><h1>{_esc(t.title[:60])}</h1><p>Mock direction {label}</p><button style="padding:12px 20px;border:0;border-radius:10px">Get started</button></div></body></html>'
            arts.append(ArtifactOut(type="html", title=f"Mockup {label}", payload={"html": html, "direction": label, "name": f"Direction {label}"}))
    return RunResponse(summary=f"{name.title()} agent finished “{t.title}”{rev}.", notes="Generated in mock mode.", artifacts=arts, consultations=state.consultations)


def _esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# ---------------------------------------------------------------- real mode
async def _consult(frm: str, to: str, question: str, req: RunRequest, state: _State, stack: list[str]) -> None:
    if not state.can_consult(stack, to):
        return
    answer = await complete_text(
        f"You are {PERSONA[to]}. A colleague ({frm}) asks for input. Answer in at most 6 sentences.",
        f"Question: {question}\n\n{render_brief(req)}",
        max_tokens=600,
    )
    state.consultations.append(Consultation(from_agent=frm, to_agent=to, question=question[:500], answer=answer[:2000], depth=len(stack)))


CHECKED = ("research", "marketing", "designer", "communication", "code")


def _kind(name: str) -> str:
    return {"research": "a sourced research report", "marketing": "a go-to-market / strategy plan", "designer": "a design brief",
            "code": "an implementation plan (files, steps, risks, tests)"}[name]


async def _draft_text(name: str, task: str, consulted: str, model: str | None, fixes: list[str] | None = None) -> str:
    fix = ("\n\nA reviewer found these defects in your previous draft. Fix every one:\n- " + "\n- ".join(fixes)) if fixes else ""
    return await complete_text(
        f"You are {PERSONA[name]}. Produce {_kind(name)} in Markdown with a short summary at the top and a Sources section citing the labels you used. "
        "Use the CURRENT decision values from the brief. Never invent facts, numbers or sources: if something is unknown, say so under 'Open questions'.",
        f"{task}{consulted}{fix}", max_tokens=3500, model=model)


async def _draft_email(req: RunRequest, task: str, consulted: str, model: str | None, fixes: list[str] | None = None) -> dict:
    fix = ("\n\nA reviewer found these defects in your previous draft. Fix every one:\n- " + "\n- ".join(fixes)) if fixes else ""
    return await complete_json(
        "You draft emails. NEVER invent email addresses: only use addresses present in the task or sources; otherwise leave `to` empty and set "
        "missing_recipients=true. Every date, number and name must come from the brief; use the CURRENT decision values. "
        "If you are replying to one of the source emails, set reply_to_source to that source's exact label. "
        "Write in the language of the thread you reply to, otherwise the language of the meeting, otherwise English. "
        "facts_used lists every date, number, name or decision you rely on, each with its source (decision, meeting, thread, task or project). "
        "attach_ids: ONLY ids from 'Files from other work that an email could attach' when the task implies sending a file (e.g. 'send the deck'); never invent ids; empty if no file is implied. "
        'Return {"to":[],"cc":[],"subject":"","body":"","missing_recipients":bool,"open_questions":[],"summary":"","reply_to_source":null,"facts_used":[{"fact":"","source":""}],"attach_ids":[]}.',
        f"{task}{consulted}{fix}", max_tokens=1500, model=model)


ATTACH_WORDS = re.compile(r"\b(attach\w*|send (?:the |a |an )?(?:deck|report|pdf|document|presentation|plan|proposal|brief|file|slides?|mockups?|designs?)|with the (?:deck|report|pdf|document|presentation|plan|proposal))\b", re.I)
ATTACH_CLAIM = re.compile(r"\b(attached|attachment|enclosed|adjunto|adjuntos|ci-joint|anexo|beigef\w+)\b|please find", re.I)
FACT_SOURCES = {"decision", "meeting", "thread", "task", "project"}


def _suggested_files(req: RunRequest, data: dict) -> list[str]:
    """Only ids the brief actually offered; at most 3; never invented."""
    offered = {f.id for f in req.files}
    out: list[str] = []
    for i in data.get("attach_ids") or []:
        if isinstance(i, str) and i in offered and i not in out:
            out.append(i)
    return out[:3]


def _facts(data: dict) -> list[dict]:
    out = []
    for f in data.get("facts_used") or []:
        if isinstance(f, dict) and str(f.get("fact") or "").strip():
            src = str(f.get("source") or "").strip().lower()
            out.append({"fact": str(f["fact"]).strip()[:200], "source": src if src in FACT_SOURCES else "project"})
    return out[:8]


def _email_payload(req: RunRequest, data: dict) -> tuple[dict, "CtxItem | None"]:
    allowed = _allowed_emails(req)
    keep = lambda xs: [str(x).strip() for x in (xs or []) if str(x).strip().lower() in allowed][:10]  # drop anything not in the sources
    src = next((c for c in req.context if c.label == data.get("reply_to_source")), None) or _thread_source(req)
    reply = _reply_fields(src)
    to = keep(data.get("to")) or [e for e in reply.get("to", []) if e.lower() in allowed]
    payload = {"to": to, "cc": keep(data.get("cc")), "subject": str(data.get("subject") or reply.get("subject") or req.task.title)[:300],
               "body": str(data.get("body", ""))[:50000], "missing_recipients": not to,
               "open_questions": [str(x) for x in data.get("open_questions", [])][:5], "sources": [src.label] if src else [c.label for c in req.context],
               "facts": _facts(data), "suggested_attachments": _suggested_files(req, data), "attachments": [],
               **{k: v for k, v in reply.items() if k in ("thread_id", "in_reply_to", "references") and v}}
    return payload, src


async def _real_run(name: str, req: RunRequest, state: _State, trace: Trace) -> RunResponse:
    if name == "research":
        from research import run_research  # lazy: research imports this module

        return await run_research(req, state, trace)
    if name == "marketing":
        from marketing import run_marketing

        return await run_marketing(req, state, trace)
    if name == "designer":
        from designer import run_designer

        return await run_designer(req, state, trace)
    model = agent_model(name)
    task = _task_block(req)
    async with trace.step("read", "Read the brief", {"lines": len(req.source_lines), "decisions": len(req.decisions), "neighbours": len(req.neighbours),
                                                    "memory": len(req.context), "prior_work": len(req.prior_work)}):
        pass
    options = CONSULT_OPTIONS[name]
    if options:  # ask whether another specialist's input is needed (agents help each other)
        async with trace.step("plan", "Decide whether another specialist is needed") as st:
            plan = await complete_json(
                f"You are {PERSONA[name]}. Decide whether you need input from another specialist before starting. "
                f'Options: {options}. Return {{"consult":[{{"agent":"<option>","question":"<specific question>"}}]}} (empty list if none needed).',
                task, max_tokens=400, model=model)
            wanted = [i for i in (plan.get("consult") or [])[:MAX_CONSULTATIONS] if isinstance(i, dict) and i.get("agent") in options and isinstance(i.get("question"), str)]
            st["detail"]["consult"] = [w["agent"] for w in wanted]
        for item in wanted:
            async with trace.step("consult", f"Ask the {item['agent']} agent", {"question": item["question"][:300]}):
                await _consult(name, item["agent"], item["question"], req, state, [name])
    consulted = "".join(f"\nInput from {c.to_agent}: {c.answer}" for c in state.consultations)

    if name == "communication":
        async with trace.step("draft", "Draft the email"):
            data = await _draft_email(req, task, consulted, model)
            payload, src = _email_payload(req, data)
        grounding = brief_text_for_facts(req)
        async with trace.step("check", "Check every date, number and name against the meeting") as st:
            issues = unsupported_facts(f"{payload['subject']}\n{payload['body']}", grounding)
            check = await self_check(name, task, f"Subject: {payload['subject']}\n\n{payload['body']}", model=model)
            problems = [f"“{x}” is not in the brief" for x in issues] + check.blocking
            st["detail"]["issues"] = problems
        if problems:
            async with trace.step("draft", "Repair the draft") as st:
                data = await _draft_email(req, task, consulted, model, fixes=problems)
                payload, src = _email_payload(req, data)
                issues = unsupported_facts(f"{payload['subject']}\n{payload['body']}", grounding)
                check = await self_check(name, task, f"Subject: {payload['subject']}\n\n{payload['body']}", model=model)
                st["detail"]["remaining"] = issues + check.blocking
            check.blocking = check.blocking + [f"“{x}” is not in the brief" for x in issues]
        open_q = [*payload.get("open_questions", []), *check.open_questions, *[f"Confirm {b}" for b in check.blocking]]
        if not payload["to"]:
            open_q.insert(0, "Who should receive this email?")
        if ATTACH_CLAIM.search(payload["body"]) and not payload["suggested_attachments"]:
            open_q.append("The email text mentions an attachment, but no file is attached. Attach one or reword the email.")
        if ATTACH_WORDS.search(f"{req.task.title} {req.task.description or ''}") and not payload["suggested_attachments"]:
            open_q.append("The task mentions a file to send, but no matching deliverable was found. Attach one once it is ready.")
        payload["open_questions"] = list(dict.fromkeys(open_q))[:6]
        conf = check.confidence * (0.6 if check.blocking else 1.0) * (0.85 if not payload["to"] else 1.0)
        return RunResponse(summary=str(data.get("summary") or f"Drafted an email for “{req.task.title}”.")[:500],
                           notes="Check recipients before sending." if not payload["to"] else "",
                           artifacts=[ArtifactOut(type="email_draft", title="Email draft", payload=payload)], consultations=state.consultations,
                           confidence=round(conf, 2), open_questions=payload["open_questions"])

    async with trace.step("draft", f"Write the {_kind(name).split(' (')[0].replace('a ', '', 1)}"):
        md = await _draft_text(name, task, consulted, model)
    async with trace.step("check", "Self-check against the brief") as st:
        check = await self_check(name, task, md, model=model)
        st["detail"]["blocking"] = check.blocking
    if not check.passed:
        async with trace.step("draft", "Repair the draft") as st:
            md = await _draft_text(name, task, consulted, model, fixes=check.blocking)
            check = await self_check(name, task, md, model=model)
            st["detail"]["remaining"] = check.blocking
    arts = [ArtifactOut(type="markdown", title="Implementation plan" if name == "code" else f"{name.title()} deliverable", content=md)]
    if name == "designer":
        async with trace.step("draft", "Sketch a concept image"):
            svg = await complete_text("Produce ONE self-contained SVG concept sketch (viewBox 0 0 320 180, no scripts, no external links). Output only the <svg> element.",
                                      f"{req.task.title}\n\nBrief:\n{md[:1500]}", max_tokens=2500, model=model)
        m = re.search(r"<svg[\s\S]*</svg>", svg)
        if m and not re.search(r"<script|on\w+\s*=|href\s*=\s*[\"']https?:", m.group(0), re.I):
            arts.append(ArtifactOut(type="image", title="Concept sketch", payload={"mime": "image/svg+xml", "svg": m.group(0)}))
    first = next((ln.lstrip("# ").strip() for ln in md.splitlines() if ln.strip()), req.task.title)
    open_q = list(dict.fromkeys([*check.open_questions, *[f"Confirm {b}" for b in check.blocking]]))[:6]
    return RunResponse(summary=first[:300], notes="", artifacts=arts, consultations=state.consultations,
                       confidence=round(check.confidence * (0.6 if check.blocking else 1.0), 2), open_questions=open_q)


MAX_FILE_BYTES = 10 * 1024 * 1024  # per file (docs/09 §1.8)
DECK_WORDS = re.compile(r"\b(deck|slides?|presentation|pitch|keynote|powerpoint|pptx)\b", re.I)


def _slug(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "-", s).strip("-").lower()[:50] or "document"


def attach_pdfs(out: RunResponse, name: str, req: RunRequest) -> None:
    """Every Markdown deliverable also gets a real PDF: what the reviewer reads is what they can download and attach.
    Deck/presentation tasks get a landscape, one-slide-per-page PDF. A failure here never fails the run."""
    wants_deck = bool(DECK_WORDS.search(f"{req.task.title} {req.task.description or ''}"))
    for art in list(out.artifacts):
        if art.type != "markdown" or not art.content:
            continue
        try:
            spec = markdown_to_spec(art.content, title=req.task.title, layout="slides" if wants_deck else "document")
            data, pages = build_pdf(spec)
        except Exception as e:  # noqa: BLE001 - the Markdown deliverable is still delivered
            out.notes = (out.notes + " " if out.notes else "") + f"PDF could not be generated ({type(e).__name__})."
            continue
        if len(data) > MAX_FILE_BYTES:
            out.notes = (out.notes + " " if out.notes else "") + "PDF was too large to attach."
            continue
        many = sum(1 for a in out.artifacts if a.type == "markdown") > 1
        fname = f"{_slug(req.task.title)}{'-' + _slug(art.title or '') if many else ''}{'-slides' if wants_deck else ''}.pdf"
        out.artifacts.append(ArtifactOut(type="pdf", title=f"{'Slides' if wants_deck else art.title or 'Report'} (PDF)", payload={
            "filename": fname, "mime": "application/pdf", "pages": pages, "size": len(data), "layout": "slides" if wants_deck else "document",
            "file_b64": base64.b64encode(data).decode("ascii")}))
        if wants_deck:
            out.notes = (out.notes + " " if out.notes else "") + "Editable PPTX is not generated yet; this PDF has one slide per page."


# ---------------------------------------------------------------- live review chat (docs/09 §1.11)
CHAT_SCHEMA = {
    "type": "object",
    "properties": {
        "reply": {"type": "string"},
        "kind": {"type": "string", "enum": ["ask", "change", "clarify"]},
        "proposed_change": {"type": "string"},
    },
    "required": ["reply", "kind", "proposed_change"],
    "additionalProperties": False,
}


class ChatTurn(BaseModel):
    role: Literal["user", "agent"]
    text: str = Field(max_length=6000)


class ChatRequest(BriefIn):
    message: str = Field(min_length=1, max_length=2000)
    current_output: str = Field(default="", max_length=12000)
    history: list[ChatTurn] = Field(default_factory=list, max_length=14)
    revision: int = Field(default=0, ge=0, le=10)


class ChatResponse(BaseModel):
    reply: str
    kind: Literal["ask", "change", "clarify"]
    proposed_change: str = ""
    usage: dict = Field(default_factory=dict)


def _mock_chat(req: ChatRequest) -> ChatResponse:
    m = req.message.strip()
    if m.endswith("?"):
        return ChatResponse(reply=f"[mock] About “{m[:80]}”: it follows the brief and the current decisions.", kind="ask")
    if len(m.split()) < 3:
        return ChatResponse(reply="[mock] Could you say a bit more about what you want changed?", kind="clarify")
    return ChatResponse(reply=f"[mock] I will change the work as you asked: {m[:120]}. Click Apply & rerun when ready.", kind="change", proposed_change=m[:200])


async def chat_with_agent(name: str, req: ChatRequest) -> ChatResponse:
    usage = begin_usage()
    if os.environ.get("AGENTS_MODE") == "mock":
        out = _mock_chat(req)
        out.usage = usage
        return out
    history = "\n".join(f"{'Reviewer' if t.role == 'user' else 'You'}: {t.text}" for t in req.history)
    data = await chat_json(
        f"You are {PERSONA[name]}. You produced the work shown below and the reviewer is talking to you live while reviewing it. "
        "Rules: (1) Questions about the work: answer from the brief and your output, honestly; if the brief does not say, say you do not know. Use kind=ask and proposed_change=\"\". "
        "(2) A request to change the work: state precisely what you will change in `proposed_change` (1-2 sentences) and confirm in `reply`. Use kind=change. "
        "You cannot change the work inside this chat: changes are made when the reviewer clicks Apply & rerun, so never say you already changed it. "
        "(3) If the request is ambiguous or you need a decision, ask ONE specific question. Use kind=clarify. "
        "Never invent facts, dates or numbers. Keep `reply` under 120 words.",
        f"{render_brief(req)}\n\nYour current output (revision {req.revision}):\n<untrusted_source label=\"current output\">{req.current_output.replace('<', ' ').replace('>', ' ')}</untrusted_source>"
        f"\n\nConversation so far:\n{history or '(none)'}\n\nReviewer: {req.message}",
        CHAT_SCHEMA, max_tokens=500, model=agent_model(name))
    kind = data.get("kind") if data.get("kind") in ("ask", "change", "clarify") else "ask"
    reply = str(data.get("reply") or "").strip()[:2000]
    if not reply:
        raise HTTPException(status_code=502, detail="agent returned an empty reply")
    pc = str(data.get("proposed_change") or "").strip()[:500] if kind == "change" else ""
    return ChatResponse(reply=reply, kind=kind, proposed_change=pc, usage=usage)


async def _run(name: str, req: RunRequest) -> RunResponse:
    state = _State()
    usage = begin_usage()
    trace = Trace(req.execution_id, req.revision, req.callback_url, os.environ.get("INTERNAL_SECRET", ""))
    if os.environ.get("AGENTS_MODE") == "mock":
        async with trace.step("draft", "Produce the mock deliverable"):
            out = _mock_run(name, req, state)
        out.confidence = 0.8
        out.open_questions = out.open_questions or (["Who should receive this email?"] if name == "communication" and out.artifacts[0].payload and not out.artifacts[0].payload.get("to") else [])
    else:
        out = await asyncio.wait_for(_real_run(name, req, state, trace), timeout=WALL_CLOCK_SECONDS)
    if out.artifacts:
        attach_pdfs(out, name, req)
    out.usage, out.steps = usage, trace.steps
    return out


def build_router(require_secret) -> APIRouter:
    r = APIRouter(dependencies=[Depends(require_secret)])

    @r.post("/agents/{name}/run", response_model=RunResponse)
    async def run(name: AgentName, req: RunRequest) -> RunResponse:
        try:
            return await _run(name, req)
        except asyncio.TimeoutError as e:
            raise HTTPException(status_code=504, detail=f"agent run exceeded {WALL_CLOCK_SECONDS}s") from e
        except LimitExceeded as e:
            raise HTTPException(status_code=422, detail=f"agent run limit: {e}") from e
        except (KeyError, TypeError, ValueError) as e:
            raise HTTPException(status_code=502, detail=f"agent output invalid: {e}") from e

    @r.post("/agents/{name}/chat", response_model=ChatResponse)
    async def chat(name: AgentName, req: ChatRequest) -> ChatResponse:
        return await chat_with_agent(name, req)

    return r
