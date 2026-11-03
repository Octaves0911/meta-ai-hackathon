"""Designer agent (docs/09 §2.4). Muse Image is not available in India, so mockups are self-contained HTML/CSS (two directions, A and B) written by the
model and then REBUILT by an allowlist sanitizer (safehtml.py). Code owns everything that must be exactly right: valid palettes, WCAG contrast,
whether the two directions really differ, that the real copy is on the page, and a guaranteed-safe fallback page if a rendering cannot be repaired."""
import asyncio
import base64
import colorsys
import io
import os
import re
import shutil
import tempfile
from html import escape

from fpdf import FPDF
from pypdf import PdfWriter

from agents import ArtifactOut, RunRequest, RunResponse, _State, _consult, _task_block
from files.pdf import latin1
from llm import agent_model, chat_json, complete_text
from quality import self_check
from research import private_terms
from runtrace import Trace
from safehtml import sanitize_html

MAX_CONSULTS = 2
MAX_PDF_BYTES = 10 * 1024 * 1024
ROLES = ["background", "surface", "text", "muted", "accent", "accent_text"]
FONT_STACKS = {
    "sans": "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    "serif": "Georgia, 'Times New Roman', Times, serif",
    "mono": "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    "rounded": "'Trebuchet MS', 'Segoe UI', system-ui, sans-serif",
}
DEFAULT_PALETTES = [
    {"background": "#0f1424", "surface": "#1a2138", "text": "#f4f6fb", "muted": "#aab3c9", "accent": "#6c8cff", "accent_text": "#0b0f19"},
    {"background": "#fbfaf7", "surface": "#ffffff", "text": "#1c1b19", "muted": "#5f5b53", "accent": "#d9480f", "accent_text": "#ffffff"},
]


# ---------------------------------------------------------------- colour maths (code, not the model)
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


def norm_hex(v: str, fallback: str) -> str:
    v = str(v or "").strip()
    if re.match(r"^#[0-9a-fA-F]{3}$", v):
        v = "#" + "".join(c * 2 for c in v[1:])
    return v.lower() if _HEX.match(v) else fallback


def _rgb(h: str) -> tuple[float, float, float]:
    return tuple(int(h[i:i + 2], 16) / 255 for i in (1, 3, 5))  # type: ignore[return-value]


def luminance(h: str) -> float:
    def ch(c: float) -> float:
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (ch(c) for c in _rgb(h))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a: str, b: str) -> float:
    la, lb = sorted((luminance(a), luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def best_on(bg: str) -> str:
    return "#0b0f19" if contrast("#0b0f19", bg) >= contrast("#ffffff", bg) else "#ffffff"


def hue(h: str) -> float:
    r, g, b = _rgb(h)
    return colorsys.rgb_to_hls(r, g, b)[0] * 360


def fix_palette(raw: dict, fallback: dict) -> tuple[dict, list[str]]:
    """Valid hex for every role, then WCAG AA contrast for the pairs that carry text. Returns (palette, notes about what was adjusted)."""
    p = {r: norm_hex(raw.get(r), fallback[r]) for r in ROLES}
    notes: list[str] = []
    for fg, bg, need in (("text", "background", 4.5), ("text", "surface", 4.5), ("accent_text", "accent", 4.5), ("muted", "background", 3.0)):
        if contrast(p[fg], p[bg]) < need:
            old = p[fg]
            p[fg] = best_on(p[bg])
            notes.append(f"{fg.replace('_', ' ')} {old} on {bg} {p[bg]} was {contrast(old, p[bg]):.1f}:1, changed to {p[fg]} ({contrast(p[fg], p[bg]):.1f}:1)")
    return p, notes


def directions_differ(a: dict, b: dict) -> bool:
    """Two directions must be visibly different: another hue, or one dark and one light."""
    dh = abs(hue(a["accent"]) - hue(b["accent"]))
    dh = min(dh, 360 - dh)
    return dh >= 25 or abs(luminance(a["background"]) - luminance(b["background"])) >= 0.25


# ---------------------------------------------------------------- the structured brief
_PALETTE_PROPS = {r: {"type": "string"} for r in ROLES}
_DIRECTION = {
    "type": "object",
    "properties": {
        "name": {"type": "string"}, "concept": {"type": "string"}, "mood": {"type": "string"}, "layout": {"type": "string"},
        "palette": {"type": "object", "properties": _PALETTE_PROPS, "required": ROLES, "additionalProperties": False},
        "heading_font": {"type": "string", "enum": list(FONT_STACKS)}, "body_font": {"type": "string", "enum": list(FONT_STACKS)},
    },
    "required": ["name", "concept", "mood", "layout", "palette", "heading_font", "body_font"], "additionalProperties": False,
}
BRIEF_SCHEMA = {
    "type": "object",
    "properties": {
        "goal": {"type": "string"}, "audience": {"type": "string"},
        "constraints": {"type": "array", "items": {"type": "string"}},
        "copy": {"type": "object", "properties": {
            "headline": {"type": "string"}, "subhead": {"type": "string"}, "cta": {"type": "string"},
            "sections": {"type": "array", "items": {"type": "object", "properties": {"title": {"type": "string"}, "body": {"type": "string"}}, "required": ["title", "body"], "additionalProperties": False}}},
            "required": ["headline", "subhead", "cta", "sections"], "additionalProperties": False},
        "directions": {"type": "array", "items": _DIRECTION},
    },
    "required": ["goal", "audience", "constraints", "copy", "directions"], "additionalProperties": False,
}
BRIEF_RULES = (
    "You are a product designer preparing a design brief from a meeting. State the GOAL and AUDIENCE, the CONSTRAINTS the meeting set (launch date, tone, 'keep it minimal'...), and the REAL COPY "
    "(headline, subhead, call to action, up to 4 short sections) using only facts, names, prices and dates from the brief; follow the brand note if present. "
    "Then propose EXACTLY TWO directions, A and B, that are clearly different (for example one dark and bold, one light and editorial; different accent hues). "
    "NEVER invent credits ('designed by'), testimonials, statistics, awards, customer names or claims, and never name the team members: use only facts, prices and dates from the brief. "
    "Each direction: a name, a concept, a mood, a layout description, a six-colour palette as #rrggbb hex (background, surface, text, muted, accent, accent_text) and fonts from "
    "{sans, serif, mono, rounded}. Pick colours with strong contrast; text must be readable on background and surface."
)


def clean_brief(data: dict) -> dict:
    copy = data.get("copy") or {}
    sections = [{"title": str(s.get("title", ""))[:80], "body": str(s.get("body", ""))[:300]} for s in (copy.get("sections") or [])[:4] if isinstance(s, dict)]
    directions, notes = [], []
    for i, d in enumerate((data.get("directions") or [])[:2]):
        pal, n = fix_palette(d.get("palette") or {}, DEFAULT_PALETTES[i % 2])
        notes += [f"Direction {'AB'[i]}: {x}" for x in n]
        directions.append({"name": str(d.get("name", f"Direction {'AB'[i]}"))[:60], "concept": str(d.get("concept", ""))[:400], "mood": str(d.get("mood", ""))[:120],
                           "layout": str(d.get("layout", ""))[:400], "palette": pal,
                           "heading_font": d.get("heading_font") if d.get("heading_font") in FONT_STACKS else "sans", "body_font": d.get("body_font") if d.get("body_font") in FONT_STACKS else "sans"})
    return {"goal": str(data.get("goal", ""))[:300], "audience": str(data.get("audience", ""))[:300],
            "constraints": [str(c)[:200] for c in (data.get("constraints") or [])[:6]],
            "copy": {"headline": str(copy.get("headline", ""))[:140], "subhead": str(copy.get("subhead", ""))[:300], "cta": str(copy.get("cta", ""))[:40], "sections": sections},
            "directions": directions, "notes": notes}


# ---------------------------------------------------------------- rendering
def fallback_html(d: dict, copy: dict) -> str:
    """A guaranteed-safe page built from the palette and copy alone, used if the model's HTML cannot be repaired."""
    p, hf, bf = d["palette"], FONT_STACKS[d["heading_font"]], FONT_STACKS[d["body_font"]]
    secs = "".join(f"<section class=\"card\"><h2>{escape(s['title'])}</h2><p>{escape(s['body'])}</p></section>" for s in copy.get("sections", []))
    return (f"<!doctype html><html><head><title>{escape(d['name'])}</title><style>:root{{--bg:{p['background']};--surface:{p['surface']};--text:{p['text']};--muted:{p['muted']};--accent:{p['accent']};--on:{p['accent_text']}}}"
            f"*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--text);font-family:{bf};line-height:1.5}}"
            f"header{{padding:64px 24px 40px;max-width:960px;margin:0 auto}}h1{{font-family:{hf};font-size:clamp(32px,6vw,56px);line-height:1.1;margin:0 0 16px}}"
            f".sub{{color:var(--muted);font-size:20px;max-width:640px;margin:0 0 28px}}.btn{{display:inline-block;min-height:48px;padding:12px 28px;border-radius:12px;background:var(--accent);color:var(--on);font-weight:700;font-size:17px;border:0}}"
            f"main{{display:grid;gap:16px;padding:0 24px 64px;max-width:960px;margin:0 auto;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}}"
            f".card{{background:var(--surface);border-radius:16px;padding:24px}}h2{{font-family:{hf};margin:0 0 8px;font-size:20px}}p{{margin:0}}</style></head>"
            f"<body><header><h1>{escape(copy['headline'])}</h1><p class=\"sub\">{escape(copy['subhead'])}</p><button class=\"btn\">{escape(copy['cta'])}</button></header><main>{secs}</main></body></html>")


def copy_problems(copy: dict, req: RunRequest) -> list[str]:
    """Public-facing copy must not name the internal team (a common slip: 'Designed by Dev with Priya')."""
    text = " ".join([copy.get("headline", ""), copy.get("subhead", ""), copy.get("cta", "")] + [f"{s['title']} {s['body']}" for s in copy.get("sections", [])])
    return [f"the copy names a team member ({n}); product copy must not credit or name internal people" for n in sorted(private_terms(req)) if re.search(rf"\b{re.escape(n)}\b", text, re.I)]


def extract_html(text: str) -> str:
    m = re.search(r"<!doctype html.*?</html>|<html.*?</html>", text, re.I | re.S)
    if m:
        return m.group(0)
    fence = re.search(r"```(?:html)?\s*(.*?)```", text, re.S | re.I)
    return fence.group(1) if fence else text


def _plain(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", s)).strip().lower()


def check_html(html: str, copy: dict) -> list[str]:
    """Deterministic checks on a SANITIZED mockup: the real copy is there, it has one h1, and nothing forces a wide layout."""
    text = _plain(re.sub(r"<style\b.*?</style>", "", html, flags=re.S | re.I))
    problems = []
    if copy["headline"] and _plain(copy["headline"]) not in text:
        problems.append(f"the headline “{copy['headline']}” is missing from the page")
    if copy["cta"] and _plain(copy["cta"]) not in text:
        problems.append(f"the call to action “{copy['cta']}” is missing from the page")
    if len(re.findall(r"<h1\b", html, re.I)) != 1:
        problems.append("the page must have exactly one <h1>")
    if re.search(r"(?<![-\w])(?:min-)?width\s*:\s*\d{4,}px", html, re.I):
        problems.append("a fixed width of 1000px or more breaks the 375px mobile layout; use fluid widths")
    return problems


def render_system(d: dict) -> str:
    return ("You write ONE self-contained HTML document: a visual mockup of the design below. Rules: all CSS inline in one <style> block; NO JavaScript; NO external resources "
            "(no <link>, remote fonts, images or URLs; decorative shapes via CSS or inline SVG only); use ONLY these system font stacks; define the palette as CSS variables and use it exactly; "
            "use the real copy word for word and add NO other text: no credits, statistics, testimonials or claims; mobile-first and responsive from 375px wide up (flex/grid, max-width, @media; no horizontal scroll); semantic HTML (header, main, sections, footer, exactly one h1); "
            "buttons at least 44px tall; body text contrast AA with the palette. Make it look like a finished, well-composed page, not a wireframe. Output ONLY the HTML document.")


async def render_direction(d: dict, brief: dict, task: str, model: str | None, fixes: list[str] | None = None) -> str:
    p = d["palette"]
    fix = ("\n\nYour previous version had these defects. Fix every one:\n- " + "\n- ".join(fixes)) if fixes else ""
    return await complete_text(
        render_system(d),
        f"{task}\n\nDirection: {d['name']}\nConcept: {d['concept']}\nMood: {d['mood']}\nLayout: {d['layout']}\n"
        f"Palette: " + ", ".join(f"{r}={p[r]}" for r in ROLES) + f"\nHeading font stack: {FONT_STACKS[d['heading_font']]}\nBody font stack: {FONT_STACKS[d['body_font']]}\n"
        f"Copy:\nheadline: {brief['copy']['headline']}\nsubhead: {brief['copy']['subhead']}\ncta: {brief['copy']['cta']}\nsections: {brief['copy']['sections']}\n"
        f"Audience: {brief['audience']}\nConstraints: {brief['constraints']}{fix}", max_tokens=5500, model=model)


async def build_mockup(d: dict, brief: dict, task: str, model: str | None) -> tuple[str, list[str]]:
    """Render, sanitize, check, repair once, and fall back to the safe page. Returns (sanitized html, notes)."""
    notes: list[str] = []
    fixes: list[str] | None = None
    for attempt in range(2):
        try:
            raw = await render_direction(d, brief, task, model, fixes)
            html, removed = sanitize_html(extract_html(raw))
        except ValueError as e:
            fixes = [f"the document was rejected: {e}"]
            continue
        problems = check_html(html, brief["copy"])
        if not problems:
            unsafe = {k: v for k, v in removed.items() if k != "meta"}  # a stray <meta> is harmless; anything else is worth saying
            if unsafe:
                notes.append(f"Direction {d['name']}: removed unsafe parts ({', '.join(sorted(unsafe))}).")
            return html, notes
        fixes = problems
    notes.append(f"Direction {d['name']}: the model's page could not be repaired, so a simpler safe page built from the same palette and copy is shown.")
    return sanitize_html(fallback_html(d, brief["copy"]))[0], notes


# ---------------------------------------------------------------- PDF of the mockups: browser if there is one, else a drawn design board
def chrome_binary() -> str | None:
    if os.environ.get("DESIGN_PDF", "auto").lower() == "board":
        return None
    for c in (os.environ.get("CHROME_BIN"), "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", shutil.which("google-chrome"), shutil.which("chromium"),
              shutil.which("chromium-browser"), shutil.which("chrome")):
        if c and os.path.exists(c):
            return c
    return None


async def pdf_via_browser(htmls: list[str]) -> bytes | None:
    exe = chrome_binary()
    if not exe:
        return None
    try:
        with tempfile.TemporaryDirectory() as d:
            parts = []
            for i, h in enumerate(htmls):
                src, out = os.path.join(d, f"{i}.html"), os.path.join(d, f"{i}.pdf")
                with open(src, "w", encoding="utf-8") as f:  # the page was sanitized; the CSP also blocks scripts and any network in the browser itself
                    f.write(f'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:"><meta name="viewport" content="width=device-width, initial-scale=1">{h}')
                proc = await asyncio.create_subprocess_exec(
                    exe, "--headless=new", "--disable-gpu", "--no-pdf-header-footer", f"--user-data-dir={os.path.join(d, f'profile{i}')}",
                    f"--print-to-pdf={out}", f"file://{src}", stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
                try:
                    await asyncio.wait_for(proc.wait(), timeout=45)
                except asyncio.TimeoutError:
                    proc.kill()
                    return None
                if not os.path.exists(out) or os.path.getsize(out) < 500:
                    return None
                parts.append(out)
            w = PdfWriter()
            for p in parts:
                w.append(p)
            buf = io.BytesIO()
            w.write(buf)
            return buf.getvalue()
    except Exception:  # noqa: BLE001 - a missing or broken browser must never fail the run
        return None


def _rgb255(h: str) -> tuple[int, int, int]:
    return tuple(int(c * 255) for c in _rgb(h))  # type: ignore[return-value]


def board_pdf(brief: dict) -> bytes:
    """Fallback when no browser can render the HTML: a design board per direction (palette swatches, type, and a miniature of the hero) drawn directly."""
    pdf = FPDF(orientation="L", unit="mm", format="A4")
    pdf.set_auto_page_break(False)
    fam = {"sans": "Helvetica", "serif": "Times", "mono": "Courier", "rounded": "Helvetica"}
    for i, d in enumerate(brief["directions"]):
        p = d["palette"]
        pdf.add_page()
        pdf.set_text_color(24, 28, 38)
        pdf.set_font("Helvetica", "B", 20)
        pdf.set_xy(14, 12)
        pdf.cell(0, 9, latin1(f"Direction {'AB'[i]}: {d['name']}")[:80])
        pdf.set_font("Helvetica", "", 10.5)
        pdf.set_xy(14, 24)
        pdf.multi_cell(150, 5, latin1(f"{d['concept']}\nMood: {d['mood']}\nLayout: {d['layout']}")[:600], align="L")
        for j, r in enumerate(ROLES):  # swatches
            x, y = 14 + (j % 3) * 50, 62 + (j // 3) * 24
            pdf.set_fill_color(*_rgb255(p[r]))
            pdf.set_draw_color(200, 204, 212)
            pdf.rect(x, y, 46, 14, style="DF")
            pdf.set_font("Helvetica", "", 8)
            pdf.set_text_color(24, 28, 38)
            pdf.set_xy(x, y + 15)
            pdf.cell(46, 4, f"{r.replace('_', ' ')} {p[r]}")
        pdf.set_xy(14, 112)  # type specimen
        pdf.set_font(fam[d["heading_font"]], "B", 18)
        pdf.cell(150, 8, latin1(brief["copy"]["headline"])[:48])
        pdf.set_xy(14, 122)
        pdf.set_font(fam[d["body_font"]], "", 11)
        pdf.cell(150, 6, latin1(brief["copy"]["subhead"])[:90])
        # hero miniature on the right
        x0, y0, w, h = 172, 14, 110, 150
        pdf.set_fill_color(*_rgb255(p["background"]))
        pdf.rect(x0, y0, w, h, style="F")
        pdf.set_text_color(*_rgb255(p["text"]))
        pdf.set_font(fam[d["heading_font"]], "B", 17)
        pdf.set_xy(x0 + 8, y0 + 18)
        pdf.multi_cell(w - 16, 8, latin1(brief["copy"]["headline"])[:70], align="L")
        pdf.set_text_color(*_rgb255(p["muted"]))
        pdf.set_font(fam[d["body_font"]], "", 10)
        pdf.set_xy(x0 + 8, pdf.get_y() + 3)
        pdf.multi_cell(w - 16, 5, latin1(brief["copy"]["subhead"])[:140], align="L")
        by = pdf.get_y() + 8
        pdf.set_fill_color(*_rgb255(p["accent"]))
        pdf.rect(x0 + 8, by, 46, 11, style="F")
        pdf.set_text_color(*_rgb255(p["accent_text"]))
        pdf.set_font("Helvetica", "B", 10)
        pdf.set_xy(x0 + 8, by + 2.5)
        pdf.cell(46, 6, latin1(brief["copy"]["cta"])[:22], align="C")
        for k, s in enumerate(brief["copy"]["sections"][:3]):
            pdf.set_fill_color(*_rgb255(p["surface"]))
            pdf.rect(x0 + 8, by + 22 + k * 22, w - 16, 18, style="F")
            pdf.set_text_color(*_rgb255(p["text"]))
            pdf.set_font("Helvetica", "B", 9)
            pdf.set_xy(x0 + 11, by + 24 + k * 22)
            pdf.cell(w - 22, 4, latin1(s["title"])[:40])
        pdf.set_text_color(105, 112, 126)
        pdf.set_font("Helvetica", "", 8)
        pdf.set_xy(14, 196)
        pdf.cell(0, 4, "Design board (the live mockup is in the review page). Prepared by MeetPilot")
    return bytes(pdf.output())


def pdf_artifact(data: bytes, slug: str, render: str) -> ArtifactOut | None:
    if not data or len(data) > MAX_PDF_BYTES:
        return None
    try:
        from pypdf import PdfReader
        pages = len(PdfReader(io.BytesIO(data)).pages)
    except Exception:  # noqa: BLE001
        pages = 0
    return ArtifactOut(type="pdf", title="Mockups (PDF)", payload={"filename": f"{slug}-mockups.pdf", "mime": "application/pdf", "pages": pages, "size": len(data), "layout": "document", "render": render,
                                                                  "file_b64": base64.b64encode(data).decode("ascii")})


# ---------------------------------------------------------------- the brief and tables
def brief_markdown(b: dict, title: str) -> str:
    c = b["copy"]
    parts = [f"# Design brief: {title}", f"## Goal\n{b['goal']}", f"## Audience\n{b['audience']}"]
    if b["constraints"]:
        parts.append("## Constraints\n" + "\n".join(f"- {x}" for x in b["constraints"]))
    sec = "\n".join(f"- **{s['title']}**: {s['body']}" for s in c["sections"])
    parts.append(f"## Copy\n**Headline:** {c['headline']}\n\n**Subhead:** {c['subhead']}\n\n**Call to action:** {c['cta']}" + (f"\n\n{sec}" if sec else ""))
    for i, d in enumerate(b["directions"]):
        p = d["palette"]
        rows = "\n".join(f"| {r.replace('_', ' ').title()} | {p[r]} |" for r in ROLES)
        parts.append(f"## Direction {'AB'[i]}: {d['name']}\n{d['concept']}\n\nMood: {d['mood']}. Layout: {d['layout']}. Fonts: {d['heading_font']} headings, {d['body_font']} body.\n\n| Colour | Hex |\n|---|---|\n{rows}")
    if b["notes"]:
        parts.append("## Adjustments made\n" + "\n".join(f"- {n}" for n in b["notes"]))
    return "\n\n".join(parts)


def palette_table(b: dict) -> ArtifactOut:
    rows = []
    for i, d in enumerate(b["directions"]):
        for r in ROLES:
            rows.append([f"{'AB'[i]}: {d['name']}", r.replace("_", " "), d["palette"][r]])
        rows.append([f"{'AB'[i]}: {d['name']}", "fonts", f"{d['heading_font']} / {d['body_font']}"])
    return ArtifactOut(type="table", title="Palette and type", payload={"columns": ["Direction", "Role", "Value"], "rows": rows})


def _slug(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "-", s).strip("-").lower()[:50] or "design"


# ---------------------------------------------------------------- the run
async def run_designer(req: RunRequest, state: _State, trace: Trace) -> RunResponse:
    model = agent_model("designer")
    task = _task_block(req)
    async with trace.step("read", "Read the brief", {"decisions": len(req.decisions), "brand_note": bool(req.brand_note), "memory": len(req.context)}):
        pass

    # 1. ask Marketing (audience, tone) and Research (reference patterns) when it helps; their answers become part of the brief
    consulted = ""
    async with trace.step("consult", "Ask Marketing and Research for audience and reference patterns") as st:
        plan = await chat_json("Decide whether input from other specialists would improve this design. marketing: audience, tone and messaging. research: how comparable products structure this kind of page. "
                               "Ask only specific questions that the brief does not already answer; at most one per specialist; empty lists if the brief is enough.",
                               task, {"type": "object", "properties": {"marketing": {"type": "string"}, "research": {"type": "string"}}, "required": ["marketing", "research"], "additionalProperties": False},
                               max_tokens=400, model=model)
        asked = [(a, str(plan.get(a) or "").strip()) for a in ("marketing", "research")]
        for agent, q in [(a, q) for a, q in asked if q][:MAX_CONSULTS]:
            await _consult("designer", agent, q[:300], req, state, ["designer"])
        st["detail"]["asked"] = [a for a, q in asked if q][:MAX_CONSULTS]
        consulted = "".join(f"\nInput from {c.to_agent}: {c.answer}" for c in state.consultations)

    # 2. the structured brief: real copy, two directions
    async with trace.step("plan", "Write the design brief and two directions") as st:
        data = await chat_json(BRIEF_RULES, f"{task}{consulted}", BRIEF_SCHEMA, max_tokens=2500, model=model)
        brief = clean_brief(data)
        if len(brief["directions"]) < 2:  # the model gave one: ask for a strongly contrasting second
            more = await chat_json(BRIEF_RULES + " Return exactly two directions.", f"{task}{consulted}\nDirection A is already: {brief['directions'][:1]}. Design a clearly different direction B and return both.", BRIEF_SCHEMA, max_tokens=2500, model=model)
            brief = clean_brief(more)
        while len(brief["directions"]) < 2:
            i = len(brief["directions"])
            brief["directions"].append({"name": f"Direction {'AB'[i]}", "concept": "Alternative direction", "mood": "contrasting", "layout": "single column", "palette": dict(DEFAULT_PALETTES[i]), "heading_font": "sans", "body_font": "sans"})
        if not brief["copy"]["headline"]:
            brief["copy"]["headline"] = req.task.title
        if not brief["copy"]["cta"]:
            brief["copy"]["cta"] = "Get started"
        probs = copy_problems(brief["copy"], req)
        if probs:  # one targeted re-ask before anything is rendered
            fixed = clean_brief(await chat_json(BRIEF_RULES, f"{task}{consulted}\n\nYour previous copy had these defects. Fix every one and keep everything else:\n- " + "\n- ".join(probs), BRIEF_SCHEMA, max_tokens=2500, model=model))
            if len(fixed["directions"]) >= 2 and not copy_problems(fixed["copy"], req):
                brief = fixed
        differ = directions_differ(brief["directions"][0]["palette"], brief["directions"][1]["palette"])
        st["detail"].update({"directions": [d["name"] for d in brief["directions"]], "differ": differ, "contrast_fixes": len(brief["notes"])})

    # 3. render both directions in parallel; each is sanitized, checked, repaired once, or replaced by the safe fallback
    async with trace.step("draft", "Design directions A and B as HTML mockups") as st:
        results = await asyncio.gather(*(build_mockup(d, brief, task, model) for d in brief["directions"]))
        htmls = [h for h, _ in results]
        brief["notes"] += [n for _, ns in results for n in ns]
        st["detail"]["bytes"] = [len(h) for h in htmls]

    arts = [ArtifactOut(type="html", title=f"Mockup {'AB'[i]}: {d['name']}", payload={"html": htmls[i], "direction": 'AB'[i], "name": d["name"]}) for i, d in enumerate(brief["directions"])]
    md = brief_markdown(brief, req.task.title)
    arts += [ArtifactOut(type="markdown", title="Design brief", content=md), palette_table(brief)]

    # 4. check the whole thing
    async with trace.step("check", "Self-check against the brief and constraints") as st:
        check = await self_check("designer", task, md, model=model,
                                 note="The mockups are HTML pages rendered separately; judge the brief only. Palette contrast was verified and fixed by code. Flag invented facts in the copy, ignored constraints, "
                                      "and directions that are not clearly different.")
        st["detail"]["blocking"] = check.blocking

    problems = check.blocking + copy_problems(brief["copy"], req)
    if problems:  # one repair: redo the brief with the defects, re-render both directions, check again
        async with trace.step("draft", "Repair the brief and redo the mockups") as st:
            fixed = clean_brief(await chat_json(BRIEF_RULES, f"{task}{consulted}\n\nYour previous design brief had these defects. Fix every one and keep everything else:\n- " + "\n- ".join(problems),
                                                BRIEF_SCHEMA, max_tokens=2500, model=model))
            if len(fixed["directions"]) >= 2:
                fixed["notes"] = brief["notes"] + [n for n in fixed["notes"] if n not in brief["notes"]]
                brief = fixed
                differ = directions_differ(brief["directions"][0]["palette"], brief["directions"][1]["palette"])
                results = await asyncio.gather(*(build_mockup(d, brief, task, model) for d in brief["directions"]))
                htmls = [h for h, _ in results]
                brief["notes"] += [n for _, ns in results for n in ns if n not in brief["notes"]]
                arts = [ArtifactOut(type="html", title=f"Mockup {'AB'[i]}: {d['name']}", payload={"html": htmls[i], "direction": 'AB'[i], "name": d["name"]}) for i, d in enumerate(brief["directions"])]
                md = brief_markdown(brief, req.task.title)
                arts += [ArtifactOut(type="markdown", title="Design brief", content=md), palette_table(brief)]
                check = await self_check("designer", task, md, model=model, note="Palette contrast was verified and fixed by code. Judge the brief: flag invented facts or credits in the copy and ignored constraints.")
            st["detail"]["remaining"] = check.blocking + copy_problems(brief["copy"], req)

    # 5. a PDF of the mockups: real browser render if available, else a drawn design board
    async with trace.step("tool", "Render the mockups to PDF") as st:
        data = await pdf_via_browser(htmls)
        render = "browser"
        if data is None:
            data, render = board_pdf(brief), "board"
        st["detail"]["render"] = render
    pdf = pdf_artifact(data, _slug(req.task.title), render)
    if pdf:
        arts.append(pdf)

    remaining = check.blocking + copy_problems(brief["copy"], req)
    open_q = list(check.open_questions) + [f"Confirm {b}" for b in remaining]
    if not differ:
        open_q.append("Directions A and B are close in colour. Ask for a bolder contrast if you want a clearer choice.")
    if brief["notes"]:
        open_q.append("Some colours or pages were adjusted automatically (contrast or unsafe code). See 'Adjustments made' in the brief.")
    if not req.brand_note:
        open_q.append("No brand and voice note is set for this project, so colours and tone are proposals. Add one in project settings for on-brand results.")
    conf = check.confidence * (0.6 if remaining else 1.0) * (0.9 if not differ else 1.0) * (0.9 if any("could not be repaired" in n for n in brief["notes"]) else 1.0)
    notes = ("The mockup PDF is a drawn design board because no browser renderer is available; the live mockups are in the tabs. " if render == "board" else "") + "Approve direction A or B to continue."
    return RunResponse(summary=f"Two design directions for “{req.task.title[:80]}”: {brief['directions'][0]['name']} and {brief['directions'][1]['name']}."[:300], notes=notes.strip(), artifacts=arts,
                       consultations=state.consultations, confidence=round(conf, 2), open_questions=list(dict.fromkeys(open_q))[:7])
