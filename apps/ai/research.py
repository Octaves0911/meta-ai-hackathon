"""Research agent (docs/09 §2.1): focus on the exact question the meeting needs answered, search the web with queries built from the
meeting's own terms (minus anything private), keep only citations that resolve to a page that was really retrieved, and write a
report that separates project facts from web facts and lists what could not be verified.

Web search results carry titles and URLs only, so what we can verify is that every cited link was retrieved, not each claim."""
import datetime
import os
import re
from urllib.parse import urlsplit

from agents import ArtifactOut, RunRequest, RunResponse, _State, _task_block  # noqa: F401
from llm import agent_model, chat_json, complete_text, respond
from quality import Check, self_check
from runtrace import Trace

MAX_SEARCHES = 5
MAX_SOURCES = 8

FOCUS_SCHEMA = {
    "type": "object",
    "properties": {
        "question": {"type": "string"},
        "sub_questions": {"type": "array", "items": {"type": "string"}},
        "queries": {"type": "array", "items": {"type": "string"}},
        "already_decided": {"type": "array", "items": {"type": "string"}},
        "needs_web": {"type": "boolean"},
    },
    "required": ["question", "sub_questions", "queries", "already_decided", "needs_web"],
    "additionalProperties": False,
}


# ---------------------------------------------------------------- privacy: what may leave the system in a search query
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_URL = re.compile(r"https?://\S+")
_PHONE = re.compile(r"\+?\d[\d\s().-]{7,}\d")
_MONEY = re.compile(r"(?:[$€£₹]\s?\d[\d,]*(?:\.\d+)?(?:\s?[kKmM]\b)?|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|INR|GBP)\b)")
_LONGNUM = re.compile(r"\b\d{5,}\b")


def private_terms(req: RunRequest) -> set[str]:
    """Names of people on this project (attendees, assignee, who assigned): they never belong in a web query."""
    names = {a for a in (req.meeting.attendees if req.meeting else [])}
    names.update(x for x in (req.task.assignee, req.task.assigned_by) if x)
    return {n.lower() for n in names if len(n) >= 3}


def scrub(text: str, req: RunRequest) -> str:
    """Remove emails, phone numbers, links, amounts, long numbers and project members' names from text that will be sent to a search engine."""
    out = _EMAIL.sub(" ", text)
    out = _URL.sub(" ", out)
    out = _PHONE.sub(" ", out)
    out = _MONEY.sub(" ", out)
    out = _LONGNUM.sub(" ", out)
    for name in private_terms(req):
        out = re.sub(rf"\b{re.escape(name)}\b", " ", out, flags=re.I)
    return re.sub(r"\s+", " ", out).strip(" ,.;:-")


def clean_queries(queries: list[str], req: RunRequest) -> list[str]:
    seen, out = set(), []
    for q in queries:
        s = scrub(str(q), req)[:160]
        if len(s.split()) >= 2 and s.lower() not in seen:
            seen.add(s.lower())
            out.append(s)
    return out[:MAX_SEARCHES]


# ---------------------------------------------------------------- citations: only pages that were really retrieved
def host_of(url: str) -> str:
    h = (urlsplit(url).hostname or "").lower()
    return h[4:] if h.startswith("www.") else h


def norm_url(url: str) -> str:
    p = urlsplit(url)
    return f"{host_of(url)}{p.path.rstrip('/')}".lower()


class Retrieved:
    """URLs the search tool actually returned, in rank order."""

    def __init__(self, searches: list[dict]):
        self.items: list[dict] = []
        seen: set[str] = set()
        for s in searches:
            for r in s.get("results", []):
                if not re.match(r"^https?://", r["url"], re.I):  # only web pages; never javascript:, data:, file: ...
                    continue
                key = norm_url(r["url"])
                if key and key not in seen:
                    seen.add(key)
                    self.items.append({"url": r["url"], "title": r.get("title") or host_of(r["url"])})

    def resolve(self, cited: str) -> dict | None:
        """Exact page match first; otherwise the best-ranked retrieved page on the same site (models often cite just the domain)."""
        want = norm_url(cited)
        for it in self.items:
            if norm_url(it["url"]) == want:
                return it
        host = host_of(cited)
        if host:
            for it in self.items:
                h = host_of(it["url"])
                if h == host or h.endswith("." + host) or host.endswith("." + h):
                    return it
        return None


def annotate(text: str, annotations: list[dict], limit: int = 40) -> tuple[str, int]:
    """Claim-level citations. When the model returns url_citation spans (it does not always), put a link marker right after each cited passage
    so that number_citations verifies and numbers them like any other link. Returns (text, markers added)."""
    seen: set[tuple[int, str]] = set()
    spans = []
    for a in annotations:
        end, url = a.get("end"), str(a.get("url") or "")
        if not isinstance(end, int) or isinstance(end, bool) or not 0 < end <= len(text) or not re.match(r"^https?://", url, re.I) or (end, url) in seen:
            continue
        seen.add((end, url))
        spans.append((end, url))
    out, added = text, 0
    for end, url in sorted(spans, reverse=True)[:limit * 2]:
        if added >= limit or re.match(r"\s*(\[|\()", out[end:end + 4]):   # already followed by a link or a marker
            continue
        out = out[:end] + f" [] ({url.replace('(', '%28').replace(')', '%29')})".replace("] (", "](") + out[end:]
        added += 1
    return out, added


_MD_LINK = re.compile(r"\[([^\]]*)\]\((https?://[^)\s]+)\)")
_BARE = re.compile(r"https?://[^\s)\]>\"']+")


def number_citations(text: str, retrieved: Retrieved) -> tuple[str, list[dict], int]:
    """Rewrite every link in `text` to a numbered marker [n] for a page that was really retrieved; links that resolve to nothing are
    removed and counted. Returns (text, sources in citation order, number of unverified links dropped)."""
    sources: list[dict] = []
    dropped = 0

    def num(url: str) -> int | None:
        hit = retrieved.resolve(url.rstrip(".,;"))
        if not hit:
            return None
        for i, s in enumerate(sources):
            if norm_url(s["url"]) == norm_url(hit["url"]):
                return i + 1
        sources.append(hit)
        return len(sources)

    def md(m: re.Match) -> str:
        nonlocal dropped
        n = num(m.group(2))
        if n is None:
            dropped += 1
            return m.group(1)
        return f"{m.group(1)} [{n}]" if m.group(1) else f"[{n}]"

    text = _MD_LINK.sub(md, text)

    def bare(m: re.Match) -> str:
        nonlocal dropped
        n = num(m.group(0))
        if n is None:
            dropped += 1
            return ""
        return f"[{n}]"

    text = _BARE.sub(bare, text)
    return text, sources[:MAX_SOURCES * 2], dropped


def strip_unknown_markers(report: str, count: int) -> str:
    """The report may only cite [1]..[count]; anything else is removed. Raw URLs never appear in the body (sources are listed once, at the end)."""
    report = re.sub(r"\[(\d{1,3})\]", lambda m: m.group(0) if 1 <= int(m.group(1)) <= count else "", report)
    return _BARE.sub("", report)


def sources_markdown(sources: list[dict], searched_on: str, used_web: bool, note: str = "") -> str:
    if not used_web:
        return f"\n\n## Sources\nNo web search was used. {note}".rstrip()
    rows = "\n".join(f"{i}. {s['title']} - {s['url']}" for i, s in enumerate(sources, 1))
    return (f"\n\n## Sources\nWeb sources, searched on {searched_on}. These are search results; the agent did not open the pages itself, so check figures before relying on them.\n"
            f"{rows or '(no web source could be verified)'}")


# ---------------------------------------------------------------- the run
async def run_research(req: RunRequest, state: _State, trace: Trace) -> RunResponse:
    model = agent_model("research")
    task = _task_block(req)
    today = datetime.date.today().isoformat()
    web_allowed = req.allow_web and os.environ.get("WEB_SEARCH", "on").lower() != "off"
    async with trace.step("read", "Read the brief", {"lines": len(req.source_lines), "decisions": len(req.decisions), "memory": len(req.context), "web_allowed": web_allowed}):
        pass

    # 1. focus: the exact question, what the team already decided, and search queries in the meeting's own terms
    async with trace.step("plan", "Focus on the question the meeting needs answered") as st:
        focus = await chat_json(
            "You prepare a research task. From the brief, state the single exact QUESTION to answer, 2-4 SUB_QUESTIONS, and up to 5 web search QUERIES built from the "
            "entities the meeting named (products, competitors, regions, versions, dates). List what the team has ALREADY_DECIDED so it is not researched again. "
            "Queries must be generic public search terms: never include people's names, email addresses, customer names, internal figures or prices. "
            "Set needs_web=false if the question can be answered from the project's own context.",
            task, FOCUS_SCHEMA, max_tokens=700, model=model)
        question = scrub(str(focus.get("question") or req.task.title), req) or req.task.title
        subs = [s for s in (scrub(str(x), req) for x in focus.get("sub_questions", [])[:4]) if s]
        queries = clean_queries([str(q) for q in focus.get("queries", [])], req)
        needs_web = bool(focus.get("needs_web", True))
        decided = [str(x)[:200] for x in focus.get("already_decided", [])[:6]]
        st["detail"].update({"question": question[:200], "queries": queries, "needs_web": needs_web})

    # 2. web: the search call sees only the scrubbed question, never the project context
    findings, sources, dropped, searches_made, web_error = "", [], 0, 0, ""
    use_web = web_allowed and needs_web and bool(queries or subs)
    if use_web:
        try:
            async with trace.step("search", "Search the web", {"queries": queries}) as st:
                out = await respond(
                    "You are a research analyst. Answer the question using web search. State the date of each fact where you can. "
                    "Cite sources as markdown links using the FULL page URL from your search results. If you could not verify something, say so plainly; never guess. "
                    "At most 600 words, plain findings only.",
                    f"Today is {today}.\nQuestion: {question}\nSub-questions:\n" + "\n".join(f"- {s}" for s in subs) + "\nSuggested searches:\n" + "\n".join(f"- {q}" for q in queries),
                    search=True, max_searches=MAX_SEARCHES, max_tokens=1800, model=model)
                retrieved = Retrieved(out["searches"])
                marked_text, claim_level = annotate(out["text"], out.get("annotations") or [])
                findings, sources, dropped = number_citations(marked_text, retrieved)
                searches_made = len(out["searches"])
                st["detail"].update({"searches": searches_made, "retrieved": len(retrieved.items), "cited": len(sources), "unverified_links_dropped": dropped,
                                     "claim_level_citations": claim_level})
        except Exception as e:  # noqa: BLE001 - web trouble must not lose the project-only part of the work
            web_error = f"Web search failed ({type(e).__name__})."
            use_web = False
    reason = ("Web lookups are switched off for this project." if not req.allow_web else web_error or ("The question can be answered from project context." if not needs_web else ""))

    # 3. write: project facts + web findings -> report. Sources are appended by code from the verified list.
    web_block = (f"Web findings (searched {today}; [n] marks a verified source):\n<untrusted_source label=\"web findings\">{findings.replace('<', ' ').replace('>', ' ')}</untrusted_source>"
                 if use_web and findings else "No web search was used. Do not state facts that are not in the brief.")
    decided_block = ("Already decided by the team (do not re-research; flag only if the evidence contradicts it):\n- " + "\n- ".join(decided)) if decided else ""

    async def write(fixes: list[str] | None = None) -> str:
        fix = ("\n\nA reviewer found these defects in your previous draft. Fix every one:\n- " + "\n- ".join(fixes)) if fixes else ""
        md = await complete_text(
            "You are a research analyst writing the final report in Markdown, at most 1,200 words, answering the QUESTION below for the people who were in the meeting. "
            "Sections: Summary (the answer first), Key findings (two lists: 'From the project' and 'From the web' with the search date), Comparison (a table, only if it helps), "
            "Recommendation, Risks and unknowns (include what you could not verify). Use the CURRENT decision values from the brief. "
            "Cite web facts only with the [n] markers that appear in the web findings; never write URLs and never invent a source, number or date. "
            "Do NOT write a Sources section (it is added for you).",
            f"QUESTION: {question}\n\n{task}\n\n{decided_block}\n\n{web_block}{fix}", max_tokens=3000, model=model)
        return strip_unknown_markers(md, len(sources))

    # The checker must see what the report is allowed to rely on: the brief AND the numbered web findings with their verified sources.
    numbered = "\n".join(f"[{i}] {src['title']} - {src['url']}" for i, src in enumerate(sources[:MAX_SOURCES], 1))
    grounding = f"{task}\n\n{web_block}\n\nVerified web sources:\n{numbered or '(none)'}"

    async with trace.step("draft", "Write the report"):
        body = await write()
    async with trace.step("check", "Self-check against the brief and sources") as st:
        check = await self_check("research", grounding, body, model=model)
        st["detail"]["blocking"] = check.blocking
    if not check.passed:
        async with trace.step("draft", "Repair the report") as st:
            body = await write(check.blocking)
            check = await self_check("research", grounding, body, model=model)
            st["detail"]["remaining"] = check.blocking

    shown = sources[:MAX_SOURCES]
    report = body.rstrip() + sources_markdown(shown, today, use_web, reason)
    arts = [ArtifactOut(type="markdown", title="Research report", content=report)]
    if use_web and shown:
        arts.append(ArtifactOut(type="link", title=f"Sources ({len(shown)})", payload={"items": [{"title": s["title"], "url": s["url"], "host": host_of(s["url"])} for s in shown], "searched_on": today}))

    open_q = list(check.open_questions) + [f"Confirm {b}" for b in check.blocking]
    if reason and req.allow_web is False:
        open_q.append("Web lookups are off for this project, so this report uses project context only.")
    elif web_error:
        open_q.append("Web search was unavailable, so this report uses project context only. Retry to add web sources.")
    if use_web and dropped:
        open_q.append(f"{dropped} cited link(s) were not among the pages actually retrieved and were removed.")
    if use_web and len(shown) < 2:
        open_q.append("Fewer than two web sources could be verified; treat the web findings as indicative.")
    conf = check.confidence * (0.6 if check.blocking else 1.0)
    if needs_web and not use_web:
        conf *= 0.8
    if use_web and len(shown) < 2:
        conf *= 0.85
    first = next((ln.lstrip("# ").strip() for ln in body.splitlines() if ln.strip() and not ln.startswith("#")), req.task.title)
    return RunResponse(summary=first[:300], notes="Web sources are search results; the agent did not open the pages." if use_web else "", artifacts=arts,
                       consultations=state.consultations, confidence=round(conf, 2), open_questions=list(dict.fromkeys(open_q))[:6])
