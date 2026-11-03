"""Marketing agent (docs/09 §2.3). The model decides WHAT the campaign is (audience, positioning, channels, phases with owners, KPIs);
code does everything that must be exactly right: dates counted back from the launch date in the decisions, owners checked against
the real team, a timeline-fit check against today's date, and an assumption label on every KPI the brief or Research does not support.

Task types (decided): `plan` (campaign/GTM/positioning), `copy` (press release, posts, announcement text: the text IS the deliverable)
or `both`."""
import datetime
import re
from datetime import date, timedelta
from typing import Literal

from agents import MAX_CONSULTATIONS, ArtifactOut, RunRequest, RunResponse, _State, _consult, _task_block
from brief import brief_text_for_facts
from llm import agent_model, chat_json, complete_text
from quality import self_check, unsupported_facts
from runtrace import Trace

PLAN_NOTE = ("The Timeline table dates are computed by the system from the decided launch date and today's date, so they are correct by construction; do not flag them. "
             "Audience, positioning, channels and phase names are the planner's proposals, not facts that need sources. Flag only: invented numbers, prices or dates in the prose; "
             "ignored decisions (launch date, price); owners who are not real people from the brief; KPI targets presented as facts.")
COPY_NOTE = ("Bracketed placeholders such as [Product] or [Contact name] are intentional where the brief lacks the fact; they are NOT defects. "
             "Flag only invented facts, wrong dates or prices, invented quotes or statistics, and ignored decisions.")

MAX_CONSULTS = 2
MAX_PHASES = 8

_MONTHS = {m: i + 1 for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}
_LAUNCH_KEYS = re.compile(r"launch|release|go[- ]?live|ship|rollout", re.I)


# ---------------------------------------------------------------- dates (code, not the model)
def parse_date(text: str, ref: date) -> date | None:
    """ISO, 'November 22', 'Nov 22nd, 2026', '22 November'. Without a year: the next such day on or after `ref`."""
    t = text.strip()
    m = re.search(r"\b(\d{4})-(\d{2})-(\d{2})\b", t)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            return None
    mon = "|".join(_MONTHS)
    m = re.search(rf"\b({mon})[a-z]*\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?(?:,?\s+(\d{{4}}))?\b", t, re.I) or None
    day = mo = yr = None
    if m:
        mo, day, yr = _MONTHS[m.group(1).lower()[:3]], int(m.group(2)), m.group(3)
    else:
        m = re.search(rf"\b(\d{{1,2}})(?:st|nd|rd|th)?\s+(?:of\s+)?({mon})[a-z]*\.?(?:,?\s+(\d{{4}}))?\b", t, re.I)
        if not m:
            return None
        day, mo, yr = int(m.group(1)), _MONTHS[m.group(2).lower()[:3]], m.group(3)
    try:
        if yr:
            return date(int(yr), mo, day)
        d = date(ref.year, mo, day)
        return d if d >= ref else date(ref.year + 1, mo, day)
    except ValueError:
        return None


def launch_date(req: RunRequest, ref: date) -> tuple[date | None, str]:
    """The CURRENT launch date from the meeting's decisions (history is ignored). Returns (date, decision text)."""
    for d in req.decisions:
        if _LAUNCH_KEYS.search(d.key):
            parsed = parse_date(d.value, ref)
            if parsed:
                return parsed, d.value
    return None, ""


def people(req: RunRequest) -> dict[str, str]:
    """Real team members mentioned in the meeting, lowercase -> display name."""
    names = list(req.meeting.attendees if req.meeting else [])
    names += [x for x in (req.task.assignee, req.task.assigned_by) if x] + [n.assignee for n in req.neighbours if n.assignee]
    return {n.lower(): n for n in names}


# ---------------------------------------------------------------- the structured plan
KIND_SCHEMA = {
    "type": "object",
    "properties": {"kind": {"type": "string", "enum": ["plan", "copy", "both"]}, "research_questions": {"type": "array", "items": {"type": "string"}}},
    "required": ["kind", "research_questions"], "additionalProperties": False,
}
PLAN_SCHEMA = {
    "type": "object",
    "properties": {
        "goal": {"type": "string"}, "audience": {"type": "string"}, "positioning": {"type": "string"},
        "pillars": {"type": "array", "items": {"type": "string"}},
        "channels": {"type": "array", "items": {"type": "object", "properties": {"name": {"type": "string"}, "reason": {"type": "string"}}, "required": ["name", "reason"], "additionalProperties": False}},
        "phases": {"type": "array", "items": {"type": "object", "properties": {
            "name": {"type": "string"}, "start_days_before": {"type": "integer"}, "end_days_before": {"type": "integer"},
            "owner": {"type": "string"}, "deliverable": {"type": "string"}}, "required": ["name", "start_days_before", "end_days_before", "owner", "deliverable"], "additionalProperties": False}},
        "kpis": {"type": "array", "items": {"type": "object", "properties": {"metric": {"type": "string"}, "target": {"type": "string"}, "basis": {"type": "string", "enum": ["brief", "research", "assumption"]}}, "required": ["metric", "target", "basis"], "additionalProperties": False}},
        "budget": {"type": "string"},
        "copy_pieces": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["goal", "audience", "positioning", "pillars", "channels", "phases", "kpis", "budget", "copy_pieces"], "additionalProperties": False,
}

PLAN_RULES = (
    "You are a marketing strategist planning a campaign from a meeting. Use ONLY facts in the brief and the research answers; never invent market data. "
    "Phases are counted BACKWARDS from launch day: start_days_before and end_days_before (start >= end >= 0; 0 = launch day). Typical order: prepare, teaser, launch, follow-up. "
    "Owner must be a real person from the brief (attendees, assignees) or the word 'Unassigned'. Channels must be realistic for this team; do not plan work nobody owns. "
    "Every KPI needs a basis: 'brief' only if the target appears in the brief, 'research' only if it appears in the research answers, otherwise 'assumption'. "
    "budget: what the brief says about budget, or 'Not discussed'. copy_pieces: the concrete texts to write (press release, launch post...) only when the task asks for them; else empty. "
    "Use the CURRENT decision values (launch date, pricing)."
)


def clean_phases(raw: list[dict], team: dict[str, str], days_left: int | None) -> tuple[list[dict], list[str]]:
    """Validate the model's phases: offsets are sane, owners are real people, and (when the launch date is known) every phase starts
    in the future. Phases that cannot fit are dropped and returned as `slips` (never squeezed into an unrealistic window)."""
    phases, slips = [], []
    for p in raw[:MAX_PHASES]:
        try:
            s, e = int(p["start_days_before"]), int(p["end_days_before"])
        except (KeyError, TypeError, ValueError):
            continue
        s, e = max(s, 0), max(min(e, s), 0)
        if days_left is not None and s > days_left:
            slips.append(f"{str(p.get('name', 'Phase'))[:60]} (would have started {s} days before launch; only {days_left} remain)")
            continue
        owner = team.get(str(p.get("owner", "")).strip().lower(), "Unassigned")
        phases.append({"name": str(p.get("name", ""))[:80], "start": s, "end": e, "owner": owner, "deliverable": str(p.get("deliverable", ""))[:160]})
    return phases, slips


def timeline_rows(phases: list[dict], launch: date | None) -> list[list[str]]:
    def fmt(days: int) -> str:
        return (launch - timedelta(days=days)).strftime("%b %d, %Y").replace(" 0", " ") if launch else f"T-{days}d" if days else "Launch day"
    return [[p["name"], fmt(p["start"]), fmt(p["end"]), p["owner"], p["deliverable"]] for p in sorted(phases, key=lambda x: -x["start"])]


def label_kpis(kpis: list[dict], grounding: str) -> list[dict]:
    """A KPI target is 'sourced' only if its figures really appear in the brief / research text; otherwise it is an assumption."""
    ground = re.sub(r"\s+", " ", grounding.lower())
    out = []
    for k in kpis[:8]:
        basis = k.get("basis") if k.get("basis") in ("brief", "research", "assumption") else "assumption"
        nums = re.findall(r"\d[\d,.]*%?", str(k.get("target", "")))
        if basis != "assumption" and nums and not all(n.lower().rstrip('.,') in ground for n in nums):
            basis = "assumption"
        if basis != "assumption" and not nums:
            basis = "assumption"
        out.append({"metric": str(k.get("metric", ""))[:120], "target": str(k.get("target", ""))[:80], "basis": basis})
    return out


def md_table(cols: list[str], rows: list[list[str]]) -> str:
    esc = lambda s: str(s).replace("|", "/").replace("\n", " ")
    return "\n".join(["| " + " | ".join(cols) + " |", "|" + "---|" * len(cols), *["| " + " | ".join(esc(c) for c in r) + " |" for r in rows]])


def assemble(plan: dict, prose: dict, rows: list[list[str]], kpis: list[dict], launch: date | None, launch_text: str, slips: list[str], budget_known: bool) -> str:
    when = f" Launch date: **{launch.strftime('%B %d, %Y').replace(' 0', ' ')}**." if launch else " No launch date was set in the meeting, so the timeline counts back from launch day."
    parts = [f"# {prose.get('title') or 'Marketing plan'}", f"## Summary\n{prose.get('summary', '').strip()}{when}", f"## Audience and positioning\n{prose.get('positioning', '').strip()}"]
    if plan.get("pillars"):
        parts.append("## Messaging pillars\n" + "\n".join(f"{i}. {p}" for i, p in enumerate(plan["pillars"][:5], 1)))
    if plan.get("channels"):
        parts.append("## Channels\n" + md_table(["Channel", "Why"], [[c.get("name", ""), c.get("reason", "")] for c in plan["channels"][:6]]))
    if rows:
        parts.append("## Timeline\n" + md_table(["Phase", "Start", "End", "Owner", "Deliverable"], rows))
    if slips:
        parts.append("## What does not fit before launch\n" + "\n".join(f"- {s}" for s in slips))
    if kpis:
        parts.append("## KPIs\n" + md_table(["Metric", "Target", "Basis"], [[k["metric"], k["target"], "From the brief" if k["basis"] == "brief" else "From research" if k["basis"] == "research" else "Assumption"] for k in kpis]))
    parts.append("## Budget\n" + (str(plan.get("budget", "")).strip() if budget_known else "No budget was discussed in the meeting. Any figure here would be an assumption, so none is given; please confirm a budget."))
    if prose.get("risks"):
        parts.append("## Risks and next steps\n" + prose["risks"].strip())
    return "\n\n".join(parts)


PROSE_SCHEMA = {
    "type": "object",
    "properties": {"title": {"type": "string"}, "summary": {"type": "string"}, "positioning": {"type": "string"}, "risks": {"type": "string"}},
    "required": ["title", "summary", "positioning", "risks"], "additionalProperties": False,
}


async def run_marketing(req: RunRequest, state: _State, trace: Trace) -> RunResponse:
    model = agent_model("marketing")
    task = _task_block(req)
    today = date.today()
    team = people(req)
    launch, launch_text = launch_date(req, today)
    days_left = (launch - today).days if launch else None
    async with trace.step("read", "Read the brief", {"decisions": len(req.decisions), "launch_date": launch.isoformat() if launch else None, "days_left": days_left, "brand_note": bool(req.brand_note)}):
        pass

    # 1. what kind of task is this, and what do we need to know from Research?
    async with trace.step("plan", "Decide plan, copy or both, and what to ask Research") as st:
        kind_data = await chat_json(
            "Classify a marketing task. kind=plan for campaigns, go-to-market, positioning, launch plans; kind=copy when the task asks for actual text (press release, launch posts, ad text, announcement); "
            "kind=both when it needs a plan and the text. research_questions: up to 2 specific market questions that only a researcher could answer (competitors, audience, benchmarks); empty if the brief is enough.",
            task, KIND_SCHEMA, max_tokens=400, model=model)
        kind = kind_data.get("kind") if kind_data.get("kind") in ("plan", "copy", "both") else "plan"
        questions = [str(q)[:300] for q in (kind_data.get("research_questions") or [])[:MAX_CONSULTS]]
        st["detail"].update({"kind": kind, "research_questions": questions})
    for q in questions:
        async with trace.step("consult", "Ask the research agent", {"question": q}):
            await _consult("marketing", "research", q, req, state, ["marketing"])
    research_text = "\n".join(f"Research answer: {c.answer}" for c in state.consultations if c.to_agent == "research")
    grounding = f"{brief_text_for_facts(req)}\n{research_text}"

    # 2. the structured plan, then the fit check against the real calendar
    async with trace.step("plan", "Plan the campaign structure") as st:
        plan = await chat_json(PLAN_RULES + (" The task wants the actual copy, so list copy_pieces." if kind != "plan" else ""),
                               f"{task}\n\n{research_text}\nToday is {today.isoformat()}." + (f"\nLaunch is in {days_left} days." if days_left is not None else "\nNo launch date is set."),
                               PLAN_SCHEMA, max_tokens=2200, model=model)
        phases, slips = clean_phases(plan.get("phases") or [], team, days_left)
        st["detail"].update({"phases": len(phases), "dropped": len(slips)})
    async with trace.step("check", "Check the timeline fits before launch") as st:
        needed = max((int(p.get("start_days_before", 0)) for p in plan.get("phases", []) if isinstance(p, dict) and str(p.get("start_days_before", "")).lstrip("-").isdigit()), default=0)
        reduced = bool(slips)
        st["detail"].update({"days_left": days_left, "days_needed": needed, "reduced": reduced})
        if reduced and days_left is not None and days_left >= 0 and len(phases) < 2:
            # almost nothing fits: ask once for a plan designed for the time that is left
            re_plan = await chat_json(PLAN_RULES + f" Only {days_left} days remain before launch: design a reduced-scope plan whose phases ALL start within the last {days_left} days.",
                                      f"{task}\n\n{research_text}\nToday is {today.isoformat()}. Launch is in {days_left} days.", PLAN_SCHEMA, max_tokens=2200, model=model)
            phases2, slips2 = clean_phases(re_plan.get("phases") or [], team, days_left)
            if phases2:
                plan, phases, slips = re_plan, phases2, slips + [f"(original full plan needed {needed} days)"] + slips2
    kpis = label_kpis(plan.get("kpis") or [], grounding)
    rows = timeline_rows(phases, launch)
    if kind == "copy":  # the text is the deliverable: no timeline, slips or KPI questions
        phases, slips, rows, kpis = [], [], [], []
    budget_known = bool(re.search(r"\d", str(plan.get("budget", ""))) and re.sub(r"\s+", " ", str(plan.get("budget", "")).lower())[:40] in re.sub(r"\s+", " ", grounding.lower()))

    # 3. prose (and copy), then assemble
    async def write_prose(fixes: list[str] | None = None) -> dict:
        fix = ("\n\nA reviewer found these defects. Fix every one:\n- " + "\n- ".join(fixes)) if fixes else ""
        return await chat_json(
            "Write the prose parts of a marketing plan. title: a short plan title. summary: 3-4 sentences, the plan in brief, using the CURRENT decision values. "
            "positioning: audience and the core message, 1 short paragraph. risks: 3-5 bullet lines of risks and next steps, Markdown list. Follow the brand note if present. "
            "Never invent numbers, dates, prices or market facts; anything uncertain is labelled 'assumption' or listed as unknown.",
            f"{task}\n\n{research_text}\nStructured plan:\n{plan}{fix}", PROSE_SCHEMA, max_tokens=1500, model=model)

    async def write_copy() -> str:
        return await complete_text(
            "You are a marketing copywriter. Write the requested texts in Markdown, one '##' section per piece, ready to publish. Follow the brand note if present. "
            "Use ONLY facts, dates and prices from the brief (current decision values); never invent quotes, statistics or customer names. Use clearly marked placeholders like [Spokesperson name] only where the brief gives nothing.",
            f"{task}\n\nPieces to write: {', '.join(plan.get('copy_pieces') or []) or 'the pieces the task asks for'}\n\nPlan context: audience {plan.get('audience')}; positioning {plan.get('positioning')}; pillars {plan.get('pillars')}",
            max_tokens=2500, model=model)

    async with trace.step("draft", "Write the plan" if kind != "copy" else "Write the copy") as st:
        prose = await write_prose() if kind != "copy" else {"title": "Launch copy", "summary": "", "positioning": "", "risks": ""}
        copy_md = await write_copy() if kind in ("copy", "both") else ""
        st["detail"]["kind"] = kind
    plan_md = assemble(plan, prose, rows, kpis, launch, launch_text, slips, budget_known) if kind != "copy" else ""

    # 4. checks: the model's review, plus a hard rule that figures not in the brief are labelled as assumptions
    def unlabelled(text: str) -> list[str]:
        keep = "\n".join(ln for ln in text.splitlines() if "assumption" not in ln.lower() and not ln.lstrip().startswith("|"))
        return unsupported_facts(keep, grounding)

    deliverable = "\n\n".join(x for x in (plan_md, copy_md) if x)
    async with trace.step("check", "Self-check against the brief and decisions") as st:
        check = await self_check("marketing", f"{task}\n\n{research_text}", deliverable, model=model, note=COPY_NOTE if kind == "copy" else PLAN_NOTE)
        bad_figs = unlabelled(prose.get("summary", "") + "\n" + prose.get("positioning", "") + "\n" + prose.get("risks", "") + ("\n" + copy_md if kind != "plan" else ""))
        problems = check.blocking + [f"“{x}” is not in the brief or research and is not labelled as an assumption" for x in bad_figs]
        st["detail"].update({"blocking": problems})
    if problems and kind != "copy":
        async with trace.step("draft", "Repair the plan") as st:
            prose = await write_prose(problems)
            plan_md = assemble(plan, prose, rows, kpis, launch, launch_text, slips, budget_known)
            deliverable = "\n\n".join(x for x in (plan_md, copy_md) if x)
            check = await self_check("marketing", f"{task}\n\n{research_text}", deliverable, model=model, note=COPY_NOTE if kind == "copy" else PLAN_NOTE)
            bad_figs = unlabelled(prose.get("summary", "") + "\n" + prose.get("positioning", "") + "\n" + prose.get("risks", ""))
            problems = check.blocking + [f"“{x}” is not in the brief or research and is not labelled as an assumption" for x in bad_figs]
            st["detail"]["remaining"] = problems

    arts: list[ArtifactOut] = []
    if plan_md:
        arts.append(ArtifactOut(type="markdown", title="Marketing plan", content=plan_md))
    if copy_md:
        arts.append(ArtifactOut(type="markdown", title="Launch copy" if kind != "both" else "Copy", content=f"# {req.task.title}\n\n{copy_md}"))
    if rows:
        arts.append(ArtifactOut(type="table", title="Timeline", payload={"columns": ["Phase", "Start", "End", "Owner", "Deliverable"], "rows": rows}))

    open_q = list(check.open_questions) + [f"Confirm {p}" for p in problems]
    if launch is None:
        open_q.append("No launch date was found in the meeting decisions, so the timeline counts back from launch day. Set the date to get real calendar dates.")
    elif days_left is not None and days_left < 0:
        open_q.append(f"The launch date ({launch.isoformat()}) has already passed. Please confirm the date.")
    if slips:
        open_q.append(f"The full plan does not fit before launch ({days_left} days left): {len(slips)} phase(s) were left out. See 'What does not fit before launch'.")
    if kind != "copy" and not budget_known:
        open_q.append("No budget was discussed; none was invented. Please confirm a budget.")
    if any(k["basis"] == "assumption" for k in kpis):
        open_q.append("Some KPI targets are assumptions, not from the meeting or research. Confirm or replace them.")
    unassigned = [r for r in rows if r[3] == "Unassigned"]
    if unassigned:
        open_q.append(f"{len(unassigned)} phase(s) have no owner. Assign them.")
    conf = check.confidence * (0.6 if check.blocking or bad_figs else 1.0)
    if launch is None:
        conf *= 0.8
    if slips:
        conf *= 0.9
    summary_src = prose.get("summary") or next((ln.lstrip("# ").strip() for ln in copy_md.splitlines() if ln.strip()), req.task.title)
    notes = ("The plan was reduced to fit the time before launch. " if slips else "") + ("Copy is ready to review; placeholders are marked in brackets." if copy_md else "")
    return RunResponse(summary=summary_src[:300], notes=notes.strip(), artifacts=arts, consultations=state.consultations,
                       confidence=round(conf, 2), open_questions=list(dict.fromkeys(open_q))[:7])
