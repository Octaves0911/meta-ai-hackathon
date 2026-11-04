"""PowerPoint builder: structure, splitting and limits. Run: cd apps/ai && INTERNAL_SECRET=x .venv/bin/python -m unittest -v"""
import io
import unittest

from pptx import Presentation

from files import build_pptx, markdown_to_spec

MD = """# Launch plan
## Summary
This plan covers the **launch campaign** for November 22.

## Steps
- Prepare the outline
- Teaser post
- Launch announcement

## Timeline
| Phase | Start | End |
|---|---|---|
| prepare | Nov 4 | Nov 14 |
| teaser | Nov 15 | Nov 21 |
| launch | Nov 22 | Nov 22 |
"""


def texts(prs):
    return [" ".join(sh.text_frame.text for sh in s.shapes if sh.has_text_frame) for s in prs.slides]


class PptxTest(unittest.TestCase):
    def test_a_real_widescreen_deck_with_a_title_slide_and_one_slide_per_section(self):
        data, n = build_pptx(markdown_to_spec(MD, title="Launch plan", layout="slides"))
        self.assertTrue(data.startswith(b"PK\x03\x04"))
        prs = Presentation(io.BytesIO(data))
        self.assertEqual(len(prs.slides), n)
        self.assertEqual(n, 4)                                               # title + Summary + Steps + Timeline
        self.assertAlmostEqual(prs.slide_width / prs.slide_height, 16 / 9, places=2)
        t = texts(prs)
        self.assertIn("Launch plan", t[0])
        self.assertIn("launch campaign", t[1])
        self.assertNotIn("**", " ".join(t))                                  # markdown marks are removed
        self.assertIn("• Prepare the outline", t[2])

    def test_a_table_becomes_a_native_table(self):
        prs = Presentation(io.BytesIO(build_pptx(markdown_to_spec(MD, title="x", layout="slides"))[0]))
        tables = [sh.table for s in prs.slides for sh in s.shapes if sh.has_table]
        self.assertEqual(len(tables), 1)
        self.assertEqual([c.text for c in tables[0].rows[0].cells], ["Phase", "Start", "End"])
        self.assertEqual(tables[0].cell(3, 0).text, "launch")

    def test_long_sections_and_tables_continue_on_following_slides(self):
        bullets = "\n".join(f"- point number {i} with a few extra words to take some room on the slide" for i in range(40))
        rows = "\n".join(f"| r{i} | {i} |" for i in range(20))
        md = f"## Many points\n{bullets}\n\n## Big table\n| Name | Value |\n|---|---|\n{rows}\n"
        prs = Presentation(io.BytesIO(build_pptx(markdown_to_spec(md, title="Long", layout="slides"))[0]))
        t = texts(prs)
        self.assertGreater(len(t), 5)
        self.assertTrue(any("(cont.)" in x for x in t))
        for s in prs.slides:
            for sh in s.shapes:
                if sh.has_table:
                    self.assertLessEqual(len(sh.table.rows), 8)             # header plus at most 7 rows

    def test_the_slide_count_is_capped_and_empty_input_still_builds(self):
        md = "\n".join(f"## Section {i}\n- a\n" for i in range(200))
        _, n = build_pptx(markdown_to_spec(md, title="Big", layout="slides"))
        self.assertLessEqual(n, 61)
        data, n = build_pptx(markdown_to_spec("", title="Empty", layout="slides"))
        self.assertEqual(n, 1)
        self.assertTrue(data.startswith(b"PK"))


if __name__ == "__main__":
    unittest.main()
