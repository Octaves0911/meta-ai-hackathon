"""PowerPoint builder: the same structured spec the PDF builder uses becomes an editable .pptx (16:9). Deterministic code lays it out; the model only wrote the content.

One title slide, then one or more slides per section: text blocks flow top to bottom, a section that does not fit continues on the next slide, and tables are split into
chunks of rows so nothing runs off the page."""
import io
import re

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Emu, Inches, Pt

from files.pdf import Block, PdfSpec

MAX_SLIDES = 60
LINE_BUDGET = 13          # rough lines of 20 pt text that fit under a slide title
TABLE_ROWS = 7
DARK, LIGHT, ACCENT, MUTED, INK = RGBColor(0x0F, 0x14, 0x24), RGBColor(0xF6, 0xF5, 0xF0), RGBColor(0x33, 0x40, 0xC4), RGBColor(0x5B, 0x63, 0x78), RGBColor(0x14, 0x1A, 0x2E)
_MD_MARK = re.compile(r"(\*\*|__)")


def _clean(text: str) -> str:
    return _MD_MARK.sub("", text or "").replace("\x00", "").strip()


def _lines(block: Block, chars_per_line: int = 78) -> int:
    def wrap(t: str) -> int:
        return max(1, -(-len(t) // chars_per_line))
    if block.kind in ("bullets", "numbered"):
        return sum(wrap(i) for i in block.items) + 1
    if block.kind == "code":
        return min(12, block.text.count("\n") + 2)
    return wrap(block.text) + 1


def _split(block: Block) -> list[Block]:
    """A long list is cut into chunks that each fit a slide; everything else is one piece."""
    if block.kind not in ("bullets", "numbered") or _lines(block) <= LINE_BUDGET:
        return [block]
    out, cur, used = [], [], 0
    for item in block.items:
        cost = max(1, -(-len(item) // 78))
        if cur and used + cost > LINE_BUDGET - 1:
            out.append(Block(kind=block.kind, items=cur))
            cur, used = [], 0
        cur.append(item)
        used += cost
    if cur:
        out.append(Block(kind=block.kind, items=cur))
    return out


def _background(slide, color: RGBColor) -> None:
    fill = slide.background.fill
    fill.solid()
    fill.fore_color.rgb = color


def _text(slide, left, top, width, height, text: str, size: int, color: RGBColor, bold: bool = False, align=PP_ALIGN.LEFT, font: str = "Calibri"):
    box = slide.shapes.add_textbox(left, top, width, height)
    tf = box.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = MSO_ANCHOR.TOP
    p = tf.paragraphs[0]
    p.alignment = align
    run = p.add_run()
    run.text = text
    run.font.size, run.font.bold, run.font.name = Pt(size), bold, font
    run.font.color.rgb = color
    return box


def _footer(slide, prs, footer: str, n: int) -> None:
    _text(slide, Inches(0.6), prs.slide_height - Inches(0.55), Inches(8), Inches(0.35), footer, 11, MUTED)
    _text(slide, prs.slide_width - Inches(1.6), prs.slide_height - Inches(0.55), Inches(1), Inches(0.35), str(n), 11, MUTED, align=PP_ALIGN.RIGHT)


def _paragraphs(slide, prs, blocks: list[Block], top) -> None:
    box = slide.shapes.add_textbox(Inches(0.7), top, prs.slide_width - Inches(1.4), prs.slide_height - top - Inches(0.8))
    tf = box.text_frame
    tf.word_wrap = True
    first = True

    def para():
        nonlocal first
        p = tf.paragraphs[0] if first else tf.add_paragraph()
        first = False
        p.space_after = Pt(8)
        return p

    for b in blocks:
        if b.kind in ("bullets", "numbered"):
            for i, item in enumerate(b.items, 1):
                p = para()
                r = p.add_run()
                r.text = (f"{i}. " if b.kind == "numbered" else "• ") + _clean(item)
                r.font.size, r.font.name = Pt(20), "Calibri"
                r.font.color.rgb = INK
        elif b.kind == "code":
            p = para()
            r = p.add_run()
            r.text = b.text[:900]
            r.font.size, r.font.name = Pt(13), "Consolas"
            r.font.color.rgb = INK
        else:
            p = para()
            r = p.add_run()
            r.text = _clean(b.text)
            r.font.size, r.font.name, r.font.italic = Pt(20), "Calibri", b.kind == "quote"
            r.font.color.rgb = MUTED if b.kind == "quote" else INK


def _table(slide, prs, columns: list[str], rows: list[list[str]], top) -> None:
    ncols = max(1, len(columns))
    width = prs.slide_width - Inches(1.4)
    shape = slide.shapes.add_table(len(rows) + 1, ncols, Inches(0.7), top, width, Inches(0.5) * (len(rows) + 1))
    table = shape.table
    for c in range(ncols):
        table.columns[c].width = Emu(int(width / ncols))
    for c, name in enumerate(columns[:ncols]):
        cell = table.cell(0, c)
        cell.text = _clean(name)
        cell.fill.solid()
        cell.fill.fore_color.rgb = ACCENT
        for p in cell.text_frame.paragraphs:
            for r in p.runs:
                r.font.size, r.font.bold, r.font.color.rgb = Pt(14), True, RGBColor(0xFF, 0xFF, 0xFF)
    for ri, row in enumerate(rows, 1):
        for c in range(ncols):
            cell = table.cell(ri, c)
            cell.text = _clean(row[c]) if c < len(row) else ""
            for p in cell.text_frame.paragraphs:
                for r in p.runs:
                    r.font.size, r.font.color.rgb = Pt(13), INK


def build_pptx(spec: PdfSpec) -> tuple[bytes, int]:
    """Returns (file bytes, number of slides)."""
    prs = Presentation()
    prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
    blank = prs.slide_layouts[6]
    n = 0

    s = prs.slides.add_slide(blank)
    n += 1
    _background(s, DARK)
    _text(s, Inches(0.9), Inches(2.4), prs.slide_width - Inches(1.8), Inches(1.6), _clean(spec.title)[:140], 44, RGBColor(0xEE, 0xF0, 0xF7), bold=True)
    if spec.subtitle:
        _text(s, Inches(0.9), Inches(4.2), prs.slide_width - Inches(1.8), Inches(1), _clean(spec.subtitle)[:200], 22, RGBColor(0xAE, 0xB6, 0xD0))
    _text(s, Inches(0.9), prs.slide_height - Inches(0.9), Inches(8), Inches(0.4), spec.footer, 12, RGBColor(0x8C, 0x9B, 0xFF))

    def content_slide(title: str):
        nonlocal n
        sl = prs.slides.add_slide(blank)
        n += 1
        _background(sl, LIGHT)
        _text(sl, Inches(0.7), Inches(0.45), prs.slide_width - Inches(1.4), Inches(0.9), title[:110], 32, INK, bold=True)
        bar = sl.shapes.add_shape(1, Inches(0.7), Inches(1.3), Inches(1.2), Emu(38100))
        bar.fill.solid()
        bar.fill.fore_color.rgb = ACCENT
        bar.line.fill.background()
        _footer(sl, prs, spec.footer, n)
        return sl

    for sec in spec.sections:
        if n >= MAX_SLIDES:
            break
        title = _clean(sec.heading) or "Overview"
        pending: list[Block] = []
        used = 0
        first = True

        def flush():
            nonlocal pending, used, first
            if not pending:
                return
            sl = content_slide(title if first else f"{title} (cont.)")
            _paragraphs(sl, prs, pending, Inches(1.55))
            pending, used, first = [], 0, False

        for b in [piece for blk in sec.blocks for piece in _split(blk)]:
            if n >= MAX_SLIDES:
                break
            if b.kind == "table" and b.rows:
                flush()
                for i in range(0, len(b.rows), TABLE_ROWS):
                    if n >= MAX_SLIDES:
                        break
                    sl = content_slide(title if first else f"{title} (cont.)")
                    _table(sl, prs, b.columns or [""] * len(b.rows[0]), b.rows[i:i + TABLE_ROWS], Inches(1.6))
                    first = False
                continue
            cost = _lines(b)
            if pending and used + cost > LINE_BUDGET:
                flush()
            pending.append(b)
            used += cost
        flush()
        if first and sec.heading:           # a heading with no content still gets a slide
            content_slide(title)

    buf = io.BytesIO()
    prs.save(buf)
    return buf.getvalue(), n
