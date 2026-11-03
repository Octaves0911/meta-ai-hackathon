"""The task brief every agent receives (docs/09 §1.2): the task, what was said around it, current decisions, sibling tasks,
project memory and earlier approved work. Rendered into one prompt block with per-section budgets; everything quoted from
people, files or mail is wrapped as untrusted data."""
from pydantic import BaseModel, Field

from llm import sanitize_label


class TaskIn(BaseModel):
    title: str = Field(max_length=300)
    description: str | None = Field(default=None, max_length=4000)
    due_date: str | None = None
    assignee: str | None = None
    priority: str | None = Field(default=None, max_length=20)
    assigned_by: str | None = Field(default=None, max_length=120)


class CtxItem(BaseModel):
    label: str = Field(max_length=300)
    text: str = Field(max_length=2000)
    # mail only: sender address, thread id, RFC Message-ID, subject (used to thread replies; never invented)
    meta: dict[str, str | None] | None = None


class MeetingIn(BaseModel):
    title: str = Field(default="", max_length=300)
    date: str | None = Field(default=None, max_length=40)
    attendees: list[str] = Field(default_factory=list, max_length=30)
    goal: str | None = Field(default=None, max_length=500)


class SourceLine(BaseModel):
    speaker: str = Field(max_length=120)
    text: str = Field(max_length=800)
    at_task: bool = False  # the sentence(s) the task was extracted from


class DecisionIn(BaseModel):
    key: str = Field(max_length=120)
    value: str = Field(max_length=400)
    previous: list[str] = Field(default_factory=list, max_length=3)  # earlier values, newest first


class NeighbourIn(BaseModel):
    title: str = Field(max_length=300)
    assignee: str | None = None
    status: str | None = None


class PriorWork(BaseModel):
    title: str = Field(max_length=300)
    agent: str = Field(max_length=40)
    summary: str = Field(default="", max_length=600)


class BriefIn(BaseModel):
    task: TaskIn
    context: list[CtxItem] = Field(default_factory=list, max_length=12)
    meeting: MeetingIn | None = None
    quote: str | None = Field(default=None, max_length=1500)
    source_lines: list[SourceLine] = Field(default_factory=list, max_length=30)
    decisions: list[DecisionIn] = Field(default_factory=list, max_length=12)
    neighbours: list[NeighbourIn] = Field(default_factory=list, max_length=12)
    prior_work: list[PriorWork] = Field(default_factory=list, max_length=4)


BUDGET = {"lines": 3500, "decisions": 1200, "neighbours": 900, "prior": 1200, "memory": 4500}


def _clean(s: str) -> str:
    return s.replace("<", " ").replace(">", " ")


def _fit(items: list[str], budget: int) -> list[str]:
    out, used = [], 0
    for it in items:
        if used + len(it) > budget:
            break
        out.append(it)
        used += len(it)
    return out


def render_context(ctx: list[CtxItem], budget: int = BUDGET["memory"]) -> str:
    def tag(c: CtxItem) -> str:
        m = c.meta or {}
        extra = "".join(f' {k}="{sanitize_label(str(m[k]))}"' for k in ("from_email", "thread_id") if m.get(k))
        return f'<untrusted_source label="{sanitize_label(c.label)}"{extra}>{_clean(c.text)}</untrusted_source>'

    rows = _fit([tag(c) for c in ctx], budget)
    return "\n".join(rows) or "(no project context found)"


def render_brief(b: BriefIn) -> str:
    """The text an agent reads before it works. Order is by value: what was asked, why, what is decided, then background."""
    t = b.task
    parts = [f"Task: {t.title}"]
    if t.description:
        parts.append(f"Spoken in the meeting: {t.description}")
    meta = [f"due {t.due_date}" if t.due_date else "", f"priority {t.priority}" if t.priority else "",
            f"assigned to {t.assignee}" if t.assignee else "", f"assigned by {t.assigned_by}" if t.assigned_by else ""]
    if any(meta):
        parts.append("Task details: " + ", ".join(m for m in meta if m))
    if b.meeting:
        m = b.meeting
        head = f"Meeting: {sanitize_label(m.title)}" + (f" ({m.date})" if m.date else "")
        if m.attendees:
            head += f"; attendees: {', '.join(sanitize_label(a, 60) for a in m.attendees[:20])}"
        if m.goal:
            head += f"; goal: {sanitize_label(m.goal, 300)}"
        parts.append(head)

    if b.source_lines or b.quote:
        lines = [f"{'>> ' if ln.at_task else ''}{sanitize_label(ln.speaker, 60)}: {_clean(ln.text)}" for ln in b.source_lines]
        body = "\n".join(_fit(lines, BUDGET["lines"]))
        if not body and b.quote:
            body = _clean(b.quote)
        parts.append(f"What was said (lines marked >> are where the task came from):\n<transcript>\n{body}\n</transcript>")

    if b.decisions:
        rows = []
        for d in b.decisions:
            hist = f" (changed from: {'; '.join(_clean(p) for p in d.previous)})" if d.previous else ""
            rows.append(f"- {sanitize_label(d.key, 80)}: {_clean(d.value)}{hist}")
        parts.append("Current decisions (always use the current value; earlier values are history):\n" + "\n".join(_fit(rows, BUDGET["decisions"])))

    if b.neighbours:
        rows = [f"- {sanitize_label(n.title, 120)}" + (f" → {sanitize_label(n.assignee, 60)}" if n.assignee else "") + (f" [{n.status}]" if n.status else "") for n in b.neighbours]
        parts.append("Other tasks from the same meeting (do not duplicate them):\n" + "\n".join(_fit(rows, BUDGET["neighbours"])))

    if b.prior_work:
        rows = [f"- {sanitize_label(p.title, 120)} ({p.agent}): {_clean(p.summary)}" for p in b.prior_work]
        parts.append("Earlier approved work on similar tasks (reuse, stay consistent):\n<untrusted_source label=\"prior work\">" + "\n".join(_fit(rows, BUDGET["prior"])) + "</untrusted_source>")

    parts.append("Project context:\n" + render_context(b.context))
    return "\n\n".join(parts)


def brief_text_for_facts(b: BriefIn) -> str:
    """Everything an output is allowed to be grounded in (used by the fact check)."""
    bits = [b.task.title, b.task.description or "", b.task.due_date or "", b.quote or ""]
    bits += [ln.text for ln in b.source_lines] + [f"{d.key} {d.value} {' '.join(d.previous)}" for d in b.decisions]
    bits += [c.text for c in b.context] + [f"{p.title} {p.summary}" for p in b.prior_work] + [n.title for n in b.neighbours]
    return "\n".join(bits)
