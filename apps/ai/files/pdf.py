"""PDF builder: a structured spec (or the Markdown an agent already wrote) becomes a real, downloadable PDF.

Pure Python (fpdf2), no system libraries. Built-in fonts only, so text is limited to Latin-1: common typography is mapped to
ASCII and anything else becomes '?' (documented limitation of the first pass)."""
import re
import unicodedata
from typing import Literal

from fpdf import FPDF
from fpdf.fonts import FontFace
from pydantic import BaseModel, Field

MAX_PAGES = 60
MAX_BLOCKS = 600

_MAP = {
    "‘": "'", "’": "'", "‚": ",", "“": '"', "”": '"', "„": '"', "–": "-", "—": "-", "−": "-",
    "…": "...", "•": "-", " ": " ", "→": "->", "←": "<-", "✓": "v", "✔": "v", "✗": "x", "✕": "x",
    "₹": "INR ", "€": "EUR ", "≤": "<=", "≥": ">=", "×": "x", "≈": "~", "​": "", "﻿": "",
}


def latin1(text: str) -> str:
    """Make text safe for the built-in PDF fonts."""
    out = []
    for ch in text:
        if ch in _MAP:
            out.append(_MAP[ch])
        elif ord(ch) < 256 and (ch.isprintable() or ch in "\n\t"):
            out.append(ch)
        else:
            base = unicodedata.normalize("NFKD", ch).encode("ascii", "ignore").decode()
            out.append(base if base else ("" if unicodedata.category(ch).startswith(("M", "C")) else "?"))
    return "".join(out)


def _break_long_tokens(text: str, n: int = 48) -> str:
    """A URL longer than the line cannot wrap; give the layout engine somewhere to break."""
    return re.sub(r"\S{%d,}" % (n + 12), lambda m: " ".join(m.group(0)[i:i + n] for i in range(0, len(m.group(0)), n)), text)


class Block(BaseModel):
    kind: Literal["paragraph", "bullets", "numbered", "table", "code", "quote"]
    text: str = ""
    items: list[str] = Field(default_factory=list)
    columns: list[str] = Field(default_factory=list)
    rows: list[list[str]] = Field(default_factory=list)


class Section(BaseModel):
    heading: str = ""
    level: int = Field(default=2, ge=1, le=3)
    blocks: list[Block] = Field(default_factory=list)


class PdfSpec(BaseModel):
    title: str
    subtitle: str = ""
    layout: Literal["document", "slides"] = "document"  # slides: landscape, one section per page
    sections: list[Section] = Field(default_factory=list)
    footer: str = "Prepared by MeetPilot"


# ------------------------------------------------------------------ Markdown -> spec
_INLINE_LINK = re.compile(r"\[([^\]]+)\]\((https?://[^)\s]+)\)")
_HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
_BULLET = re.compile(r"^\s*[-*+]\s+(.*)$")
_NUMBERED = re.compile(r"^\s*\d+[.)]\s+(.*)$")
_TABLE_SEP = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$")


def _inline(text: str) -> str:
    """Markdown inline markup -> what fpdf2's markdown mode understands (**bold**, __italic__)."""
    text = _INLINE_LINK.sub(lambda m: f"{m.group(1)} ({m.group(2)})", text)
    text = re.sub(r"`([^`]+)`", r"\1", text)
    text = re.sub(r"(?<![*\w])\*(?!\s)([^*]+?)(?<!\s)\*(?![*\w])", r"__\1__", text)
    return text.replace("<", "").replace(">", "")


def _cells(line: str) -> list[str]:
    return [c.strip() for c in line.strip().strip("|").split("|")]


def markdown_to_spec(md: str, title: str = "", layout: str = "document") -> PdfSpec:
    lines = md.replace("\r\n", "\n").split("\n")
    doc_title, sections, cur = title, [], Section()
    para: list[str] = []

    def flush_para() -> None:
        if para:
            cur.blocks.append(Block(kind="paragraph", text=_inline(" ".join(para))))
            para.clear()

    def new_section(heading: str, level: int) -> None:
        nonlocal cur
        flush_para()
        if cur.heading or cur.blocks:
            sections.append(cur)
        cur = Section(heading=_inline(heading), level=level)

    i = 0
    while i < len(lines) and len(sections) * 8 + len(cur.blocks) < MAX_BLOCKS:
        line = lines[i]
        if line.strip().startswith("```"):
            flush_para()
            i += 1
            code = []
            while i < len(lines) and not lines[i].strip().startswith("```"):
                code.append(lines[i])
                i += 1
            cur.blocks.append(Block(kind="code", text="\n".join(code)))
        elif (m := _HEADING.match(line)):
            level = len(m.group(1))
            if level == 1 and not doc_title:
                doc_title = _inline(m.group(2))
            elif level == 1 and not (cur.heading or cur.blocks) and not sections:
                doc_title = doc_title or _inline(m.group(2))
            else:
                new_section(m.group(2), min(max(level - 1, 1), 3) if level > 1 else 1)
        elif "|" in line and i + 1 < len(lines) and _TABLE_SEP.match(lines[i + 1]):
            flush_para()
            cols = _cells(line)
            rows = []
            i += 2
            while i < len(lines) and "|" in lines[i] and lines[i].strip():
                rows.append(_cells(lines[i]))
                i += 1
            cur.blocks.append(Block(kind="table", columns=[_inline(c) for c in cols], rows=[[_inline(c) for c in r] for r in rows]))
            continue
        elif _BULLET.match(line) or _NUMBERED.match(line):
            flush_para()
            numbered = bool(_NUMBERED.match(line))
            items = []
            kind_rx = _NUMBERED if numbered else _BULLET
            while i < len(lines) and (kind_rx.match(lines[i]) or (items and lines[i].startswith("  ") and lines[i].strip() and not (_BULLET.match(lines[i]) or _NUMBERED.match(lines[i])))):
                m2 = kind_rx.match(lines[i])
                if m2:
                    items.append(_inline(m2.group(1)))
                else:
                    items[-1] += " " + _inline(lines[i].strip())
                i += 1
            cur.blocks.append(Block(kind="numbered" if numbered else "bullets", items=items))
            continue
        elif line.strip().startswith(">"):
            flush_para()
            q = []
            while i < len(lines) and lines[i].strip().startswith(">"):
                q.append(lines[i].strip().lstrip(">").strip())
                i += 1
            cur.blocks.append(Block(kind="quote", text=_inline(" ".join(q))))
            continue
        elif re.match(r"^\s*([-*_])\1{2,}\s*$", line) or not line.strip():
            flush_para()
        else:
            para.append(line.strip())
        i += 1
    flush_para()
    if cur.heading or cur.blocks:
        sections.append(cur)
    return PdfSpec(title=doc_title or "Document", layout="slides" if layout == "slides" else "document", sections=sections)


# ------------------------------------------------------------------ rendering
INK, MUTED, ACCENT, RULE = (24, 28, 38), (105, 112, 126), (63, 94, 251), (214, 218, 226)


class _Pdf(FPDF):
    def __init__(self, spec: PdfSpec):
        super().__init__(orientation="L" if spec.layout == "slides" else "P", unit="mm", format="A4")
        self.spec = spec
        self.set_auto_page_break(auto=True, margin=16)
        self.set_margins(18, 18, 18)
        self.set_title(latin1(spec.title)[:200])
        self.set_creator("MeetPilot")
        self.alias_nb_pages()

    def footer(self) -> None:
        self.set_y(-11)
        self.set_font("Helvetica", "", 8)
        self.set_text_color(*MUTED)
        self.cell(0, 5, latin1(self.spec.footer)[:80], align="L")
        self.cell(0, 5, f"{self.page_no()} / {{nb}}", align="R")


def _txt(s: str) -> str:
    return _break_long_tokens(latin1(s))


def build_pdf(spec: PdfSpec) -> tuple[bytes, int]:
    """Returns (pdf bytes, page count). Raises ValueError if the document would exceed the page limit."""
    slides = spec.layout == "slides"
    pdf = _Pdf(spec)
    pdf.add_page()
    body_size = 14 if slides else 10.5
    line_h = 7 if slides else 5.4

    if slides:
        pdf.set_y(70)
    pdf.set_text_color(*INK)
    pdf.set_font("Helvetica", "B", 28 if slides else 20)
    pdf.multi_cell(0, 11 if slides else 8.5, _txt(spec.title), new_x="LMARGIN", new_y="NEXT")
    if spec.subtitle:
        pdf.set_font("Helvetica", "", 13 if slides else 11)
        pdf.set_text_color(*MUTED)
        pdf.multi_cell(0, 6.5, _txt(spec.subtitle), new_x="LMARGIN", new_y="NEXT")
    pdf.set_draw_color(*ACCENT)
    pdf.set_line_width(0.8)
    pdf.line(pdf.l_margin, pdf.get_y() + 2, pdf.l_margin + 28, pdf.get_y() + 2)
    pdf.ln(7)

    for sec in spec.sections:
        if slides:  # title slide stands alone; every section is its own slide
            pdf.add_page()
        if sec.heading:
            size = {1: 22, 2: 17, 3: 13.5}[sec.level] if not slides else {1: 24, 2: 22, 3: 18}[sec.level]
            pdf.ln(2 if not slides else 0)
            pdf.set_text_color(*INK)
            pdf.set_font("Helvetica", "B", size)
            pdf.multi_cell(0, size * 0.5, _txt(sec.heading), new_x="LMARGIN", new_y="NEXT")
            pdf.ln(1.5)
        for b in sec.blocks:
            pdf.set_text_color(*INK)
            if b.kind == "paragraph":
                pdf.set_font("Helvetica", "", body_size)
                pdf.multi_cell(0, line_h, _txt(b.text), markdown=True, align="L", new_x="LMARGIN", new_y="NEXT")
                pdf.ln(2)
            elif b.kind in ("bullets", "numbered"):
                pdf.set_font("Helvetica", "", body_size)
                for n, item in enumerate(b.items, 1):
                    mark = f"{n}." if b.kind == "numbered" else "-"
                    x = pdf.l_margin
                    pdf.set_x(x)
                    pdf.cell(7, line_h, mark)
                    pdf.set_x(x + 7)
                    pdf.multi_cell(0, line_h, _txt(item), markdown=True, align="L", new_x="LMARGIN", new_y="NEXT")
                    pdf.ln(0.8)
                pdf.ln(1.5)
            elif b.kind == "quote":
                pdf.set_font("Helvetica", "I", body_size)
                pdf.set_text_color(*MUTED)
                y0 = pdf.get_y()
                pdf.set_x(pdf.l_margin + 5)
                pdf.multi_cell(0, line_h, _txt(b.text), align="L", new_x="LMARGIN", new_y="NEXT")
                pdf.set_draw_color(*RULE)
                pdf.set_line_width(0.8)
                pdf.line(pdf.l_margin + 1.5, y0, pdf.l_margin + 1.5, pdf.get_y())
                pdf.ln(2)
            elif b.kind == "code":
                pdf.set_font("Courier", "", body_size - 2)
                pdf.set_fill_color(244, 245, 248)
                pdf.multi_cell(0, line_h - 0.6, _txt(b.text), fill=True, new_x="LMARGIN", new_y="NEXT")
                pdf.ln(2)
            elif b.kind == "table" and b.columns:
                cols = len(b.columns)
                pdf.set_font("Helvetica", "", body_size - 1)
                pdf.set_draw_color(*RULE)
                with pdf.table(col_widths=tuple([1] * cols), line_height=line_h - 0.4, text_align="LEFT", borders_layout="HORIZONTAL_LINES",
                               headings_style=FontFace(emphasis="BOLD", fill_color=(240, 242, 247)), padding=1.6) as table:
                    for r in [b.columns, *b.rows]:
                        row = table.row()
                        for j in range(cols):
                            row.cell(_txt(str(r[j]) if j < len(r) else ""))
                pdf.ln(3)
        if pdf.page > MAX_PAGES:
            raise ValueError(f"document is longer than {MAX_PAGES} pages")
    out = bytes(pdf.output())
    return out, pdf.page
