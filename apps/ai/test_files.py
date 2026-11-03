"""PDF builder and agent PDF attachment. Run: cd apps/ai && INTERNAL_SECRET=x .venv/bin/python -m unittest -v"""
import base64
import os
import unittest

import agents
from brief import TaskIn
from files import PdfSpec, build_pdf, markdown_to_spec
from files.pdf import Block, Section, latin1

MD = """# Pricing report

## Summary
Acme charges **$49/month** for *Pro*.

## Findings
- Acme: $49
- Globex: ₹3,999 — "annual" plan
1. First step
2. Second step

| Vendor | Price |
|---|---|
| Acme | $49 |
| Globex | ₹3,999 |

> Figures come from public pages.

```
npm install
```
"""


def page_count(pdf: bytes) -> int:
    return pdf.count(b"/Type /Page\n") or pdf.count(b"/Type /Page ") or pdf.count(b"/Type/Page")


class MarkdownSpecTest(unittest.TestCase):
    def test_structure_is_recovered(self):
        spec = markdown_to_spec(MD)
        self.assertEqual(spec.title, "Pricing report")
        self.assertEqual([s.heading for s in spec.sections], ["Summary", "Findings"])
        kinds = [b.kind for b in spec.sections[1].blocks]
        self.assertEqual(kinds, ["bullets", "numbered", "table", "quote", "code"])
        table = spec.sections[1].blocks[2]
        self.assertEqual(table.columns, ["Vendor", "Price"])
        self.assertEqual(table.rows[1], ["Globex", "₹3,999"])

    def test_bold_and_italic_become_pdf_markup_and_links_keep_their_url(self):
        spec = markdown_to_spec("## A\nSee **bold**, *it* and [site](https://example.com/x).")
        text = spec.sections[0].blocks[0].text
        self.assertIn("**bold**", text)
        self.assertIn("__it__", text)
        self.assertIn("site (https://example.com/x)", text)

    def test_lists_of_different_kinds_stay_separate(self):
        spec = markdown_to_spec("## A\n- x\n- y\n1. one\n2. two\n")
        self.assertEqual([(b.kind, b.items) for b in spec.sections[0].blocks], [("bullets", ["x", "y"]), ("numbered", ["one", "two"])])

    def test_empty_markdown_still_gives_a_document(self):
        build_pdf(markdown_to_spec(""))


class BuildPdfTest(unittest.TestCase):
    def test_produces_a_real_pdf_with_a_page_count(self):
        data, pages = build_pdf(markdown_to_spec(MD))
        self.assertTrue(data.startswith(b"%PDF-"))
        self.assertEqual(pages, 1)
        self.assertTrue(data.rstrip().endswith(b"%%EOF"))

    def test_long_documents_paginate_and_stop_at_the_limit(self):
        para = Block(kind="paragraph", text="word " * 400)
        data, pages = build_pdf(PdfSpec(title="Long", sections=[Section(heading=f"S{i}", blocks=[para]) for i in range(6)]))
        self.assertGreater(pages, 3)
        with self.assertRaises(ValueError):
            build_pdf(PdfSpec(title="Huge", sections=[Section(heading=f"S{i}", blocks=[para]) for i in range(150)]))

    def test_slides_layout_is_landscape_with_a_title_slide(self):
        md = "# Deck\n\n## One\n- a\n\n## Two\n- b\n"
        doc, dp = build_pdf(markdown_to_spec(md))
        slides, sp = build_pdf(markdown_to_spec(md, layout="slides"))
        self.assertEqual(sp, 3)  # title + two sections
        self.assertEqual(dp, 1)
        self.assertIn(b"/MediaBox [0 0 841.89 595.28]", slides)  # landscape A4
        self.assertIn(b"/MediaBox [0 0 595.28 841.89]", doc)  # portrait A4

    def test_hostile_and_unusual_text_never_breaks_the_build(self):
        spec = PdfSpec(title="x" * 400 + "नमस्ते \U0001f680", sections=[Section(heading="<script>alert(1)</script>", blocks=[
            Block(kind="paragraph", text="https://example.com/" + "a" * 400),
            Block(kind="table", columns=["A", "B", "C"], rows=[["only one"], ["1", "2", "3", "4"]]),
            Block(kind="bullets", items=["• already bulleted", "**unclosed bold"]),
            Block(kind="code", text="line\n" * 3)])])
        data, _ = build_pdf(spec)
        self.assertTrue(data.startswith(b"%PDF-"))

    def test_latin1_mapping(self):
        self.assertEqual(latin1("“quoted” — ₹3,999 …"), '"quoted" - INR 3,999 ...')
        self.assertEqual(latin1("café"), "café")
        self.assertNotIn("\U0001f680", latin1("go \U0001f680"))


class AgentPdfTest(unittest.IsolatedAsyncioTestCase):
    def req(self, title="Research competitor pricing", description=None):
        return agents.RunRequest(task=TaskIn(title=title, description=description))

    def out(self):
        return agents.RunResponse(summary="s", artifacts=[agents.ArtifactOut(type="markdown", title="Report", content=MD)])

    def test_markdown_deliverable_gets_a_matching_pdf(self):
        out = self.out()
        agents.attach_pdfs(out, "research", self.req())
        pdf = next(a for a in out.artifacts if a.type == "pdf")
        raw = base64.b64decode(pdf.payload["file_b64"])
        self.assertTrue(raw.startswith(b"%PDF-"))
        self.assertEqual(pdf.payload["filename"], "research-competitor-pricing.pdf")
        self.assertEqual(pdf.payload["layout"], "document")
        self.assertEqual(pdf.payload["size"], len(raw))

    def test_deck_tasks_get_slides_and_an_honest_note(self):
        out = self.out()
        agents.attach_pdfs(out, "marketing", self.req("Create the launch deck"))
        pdf = next(a for a in out.artifacts if a.type == "pdf")
        self.assertEqual(pdf.payload["layout"], "slides")
        self.assertTrue(pdf.payload["filename"].endswith("-slides.pdf"))
        self.assertIn("PPTX is not generated yet", out.notes)

    def test_non_markdown_artifacts_and_failures_never_break_the_run(self):
        out = agents.RunResponse(summary="s", artifacts=[agents.ArtifactOut(type="email_draft", title="Email", payload={"to": []})])
        agents.attach_pdfs(out, "communication", self.req())
        self.assertEqual([a.type for a in out.artifacts], ["email_draft"])
        out = self.out()
        original = agents.build_pdf
        agents.build_pdf = lambda spec: (_ for _ in ()).throw(RuntimeError("boom"))
        try:
            agents.attach_pdfs(out, "research", self.req())
        finally:
            agents.build_pdf = original
        self.assertEqual([a.type for a in out.artifacts], ["markdown"])
        self.assertIn("PDF could not be generated", out.notes)

    async def test_mock_run_attaches_a_pdf(self):
        os.environ["AGENTS_MODE"] = "mock"
        try:
            out = await agents._run("research", self.req())
        finally:
            os.environ.pop("AGENTS_MODE")
        self.assertTrue(any(a.type == "pdf" for a in out.artifacts))


if __name__ == "__main__":
    unittest.main()
