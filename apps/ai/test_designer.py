"""Designer agent: colour maths, brief cleaning, mockup checks/repair/fallback, PDF routes and full runs with the model stubbed.
Run: cd apps/ai && INTERNAL_SECRET=x .venv/bin/python -m unittest -v"""
import base64
import os
import unittest
from unittest import mock

import designer
from agents import RunRequest, _State
from brief import MeetingIn, SourceLine, TaskIn
from quality import Check
from runtrace import Trace
from safehtml import sanitize_html

DARK = {"background": "#0f1424", "surface": "#1a2138", "text": "#f4f6fb", "muted": "#aab3c9", "accent": "#6c8cff", "accent_text": "#0b0f19"}
LIGHT = {"background": "#fbfaf7", "surface": "#ffffff", "text": "#1c1b19", "muted": "#5f5b53", "accent": "#d9480f", "accent_text": "#ffffff"}
COPY = {"headline": "Meetings that follow up", "subhead": "MeetPilot turns decisions into done work.", "cta": "Start free", "sections": [{"title": "Capture", "body": "Every decision."}, {"title": "Assign", "body": "Right owner."}]}


def direction(name, pal, hf="sans", bf="sans"):
    return {"name": name, "concept": f"{name} concept", "mood": "calm", "layout": "hero then cards", "palette": dict(pal), "heading_font": hf, "body_font": bf}


def brief_data(**kw):
    base = {"goal": "Launch page for Pro", "audience": "busy teams", "constraints": ["keep it minimal"], "copy": COPY, "directions": [direction("Bold night", DARK), direction("Editorial day", LIGHT, "serif")]}
    base.update(kw)
    return base


def page(headline=COPY["headline"], cta=COPY["cta"], extra="", h1=1):
    h = "".join(f"<h1>{headline}</h1>" for _ in range(h1))
    return f"<!doctype html><html><head><style>body{{margin:0}}</style></head><body><header>{h}<p>sub</p><button>{cta}</button>{extra}</header></body></html>"


class ColourTest(unittest.TestCase):
    def test_hex_is_normalised_or_replaced(self):
        self.assertEqual(designer.norm_hex("#ABC", "#000000"), "#aabbcc")
        self.assertEqual(designer.norm_hex("#0F1424", "#000000"), "#0f1424")
        for bad in ("red", "#12", "rgb(1,2,3)", None, "#gggggg", ""):
            self.assertEqual(designer.norm_hex(bad, "#123456"), "#123456")

    def test_contrast_extremes(self):
        self.assertAlmostEqual(designer.contrast("#000000", "#ffffff"), 21.0, places=1)
        self.assertAlmostEqual(designer.contrast("#777777", "#777777"), 1.0, places=2)

    def test_unreadable_text_is_fixed_and_the_change_is_reported(self):
        bad = {**DARK, "text": "#2a3050", "accent_text": "#7a8cff"}  # dark-on-dark text, light-on-light button
        fixed, notes = designer.fix_palette(bad, DARK)
        self.assertGreaterEqual(designer.contrast(fixed["text"], fixed["background"]), 4.5)
        self.assertGreaterEqual(designer.contrast(fixed["text"], fixed["surface"]), 4.5)
        self.assertGreaterEqual(designer.contrast(fixed["accent_text"], fixed["accent"]), 4.5)
        self.assertEqual(len(notes), 2)  # text on background/surface needs ONE fix; the button text is the second
        self.assertIn("was", notes[0])

    def test_a_good_palette_is_left_alone(self):
        fixed, notes = designer.fix_palette(DARK, DARK)
        self.assertEqual((fixed, notes), (DARK, []))

    def test_directions_must_differ_by_hue_or_by_light_vs_dark(self):
        self.assertTrue(designer.directions_differ(DARK, LIGHT))
        same_dark_other_hue = {**DARK, "accent": "#ff6b6b"}
        self.assertTrue(designer.directions_differ(DARK, same_dark_other_hue))
        near = {**DARK, "background": "#10162a", "accent": "#6f8fff"}
        self.assertFalse(designer.directions_differ(DARK, near))


class BriefTest(unittest.TestCase):
    def test_exactly_two_directions_valid_fonts_and_trimmed_copy(self):
        d = brief_data(directions=[direction("A", DARK, "comic-sans", "sans"), direction("B", LIGHT), direction("C", LIGHT)], copy={**COPY, "headline": "x" * 500})
        b = designer.clean_brief(d)
        self.assertEqual(len(b["directions"]), 2)
        self.assertEqual(b["directions"][0]["heading_font"], "sans")
        self.assertEqual(len(b["copy"]["headline"]), 140)

    def test_bad_palettes_are_repaired_with_notes(self):
        d = brief_data(directions=[direction("A", {**DARK, "text": "#2a3050", "accent": "banana"}), direction("B", LIGHT)])
        b = designer.clean_brief(d)
        self.assertTrue(all(designer._HEX.match(v) for v in b["directions"][0]["palette"].values()))
        self.assertTrue(any(n.startswith("Direction A:") for n in b["notes"]))


class HtmlCheckTest(unittest.TestCase):
    def check(self, html):
        return designer.check_html(sanitize_html(html)[0], COPY)

    def test_a_good_page_passes(self):
        self.assertEqual(self.check(page()), [])

    def test_missing_copy_and_wrong_heading_structure_are_caught(self):
        self.assertTrue(any("headline" in p for p in self.check(page(headline="Something else"))))
        self.assertTrue(any("call to action" in p for p in self.check(page(cta="Buy"))))
        self.assertTrue(any("exactly one <h1>" in p for p in self.check(page(h1=2))))

    def test_fixed_wide_layouts_are_caught_but_fluid_ones_are_not(self):
        self.assertTrue(any("fixed width" in p for p in self.check(page(extra='<div style="width:1200px">x</div>'))))
        self.assertEqual(self.check(page(extra='<div style="max-width:1200px;min-width:0">x</div>')), [])

    def test_copy_text_in_css_does_not_count_as_on_the_page(self):
        sneaky = f"<html><head><style>.a:after{{content:'{COPY['headline']} {COPY['cta']}'}}</style></head><body><h1>Other</h1><p>x</p></body></html>"
        self.assertEqual(len(self.check(sneaky)), 2)

    def test_html_is_extracted_from_chatty_or_fenced_output(self):
        self.assertTrue(designer.extract_html("Sure! Here it is:\n```html\n<div><h1>Hi</h1></div>\n```\nEnjoy").startswith("<div>"))
        self.assertTrue(designer.extract_html("blah <!doctype html><html><body>x</body></html> trailing").startswith("<!doctype html>"))


class FallbackTest(unittest.TestCase):
    def test_the_safe_page_is_valid_complete_and_escapes_the_copy(self):
        d = designer.clean_brief(brief_data())["directions"][0]
        evil = {**COPY, "headline": "<script>alert(1)</script>Launch", "sections": [{"title": "<img src=x onerror=y()>", "body": "b"}]}
        html = designer.fallback_html(d, evil)
        clean, removed = sanitize_html(html)
        self.assertEqual(removed, {})  # nothing needed removing: it was safe by construction
        self.assertNotIn("<script", clean)
        self.assertNotIn("<img", clean)           # the tags are shown as escaped text, never created
        self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt;Launch", clean)

    def test_fallback_passes_the_checks_with_real_copy(self):
        d = designer.clean_brief(brief_data())["directions"][1]
        self.assertEqual(designer.check_html(sanitize_html(designer.fallback_html(d, COPY))[0], COPY), [])


class CopyTest(unittest.TestCase):
    def req(self):
        return RunRequest(task=TaskIn(title="t", assignee="dev"), meeting=MeetingIn(title="m", attendees=["dev", "priya"]))

    def test_product_copy_must_not_name_the_internal_team(self):
        bad = {**COPY, "sections": [{"title": "Launch", "body": "Pro launches November 22. Designed by Dev with Priya."}]}
        probs = designer.copy_problems(bad, self.req())
        self.assertEqual(len(probs), 2)
        self.assertEqual(designer.copy_problems(COPY, self.req()), [])
        self.assertEqual(designer.copy_problems({**COPY, "headline": "Developers love it"}, self.req()), [])  # whole words only


class MockupTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.brief = designer.clean_brief(brief_data())
        self.d = self.brief["directions"][0]

    async def build(self, outputs):
        outs = list(outputs)
        calls = []

        async def fake(d, brief, task, model, fixes=None):
            calls.append(fixes)
            return outs.pop(0) if len(outs) > 1 else outs[0]

        with mock.patch.object(designer, "render_direction", fake):
            html, notes = await designer.build_mockup(self.d, self.brief, "task", None)
        return html, notes, calls

    async def test_hostile_output_is_sanitized_and_reported(self):
        html, notes, calls = await self.build([page(extra='<script>steal()</script><div onclick="x()">k</div><a href="https://evil.example">l</a>')])
        self.assertNotIn("steal", html)
        self.assertNotIn("onclick", html)
        self.assertNotIn("evil.example", html)
        self.assertTrue(any("removed unsafe parts" in n for n in notes))
        self.assertEqual(calls, [None])

    async def test_a_stray_meta_tag_is_not_worth_a_warning(self):
        _, notes, _ = await self.build([page(extra='<meta charset="utf-8">')])
        self.assertEqual(notes, [])

    async def test_a_page_missing_the_copy_is_repaired_once(self):
        html, notes, calls = await self.build([page(headline="Wrong"), page()])
        self.assertIn("Meetings that follow up", html)
        self.assertEqual(len(calls), 2)
        self.assertTrue(any("headline" in f for f in calls[1]))
        self.assertEqual(notes, [])

    async def test_a_page_that_cannot_be_repaired_becomes_the_safe_fallback(self):
        html, notes, calls = await self.build(["not html at all", page(headline="Still wrong")])
        self.assertEqual(len(calls), 2)
        self.assertIn("Meetings that follow up", html)
        self.assertTrue(any("could not be repaired" in n for n in notes))
        self.assertEqual(designer.check_html(html, COPY), [])


class PdfTest(unittest.IsolatedAsyncioTestCase):
    def test_design_board_is_a_real_pdf_with_a_page_per_direction(self):
        b = designer.clean_brief(brief_data())
        data = designer.board_pdf(b)
        self.assertTrue(data.startswith(b"%PDF-"))
        art = designer.pdf_artifact(data, "launch", "board")
        self.assertEqual(art.payload["pages"], 2)
        self.assertEqual(art.payload["render"], "board")

    def test_the_board_survives_unusual_text(self):
        b = designer.clean_brief(brief_data(copy={**COPY, "headline": "Привет \U0001f680 " * 20, "cta": "नमस्ते"}))
        self.assertTrue(designer.board_pdf(b).startswith(b"%PDF-"))

    async def test_board_is_forced_by_the_environment(self):
        with mock.patch.dict(os.environ, {"DESIGN_PDF": "board"}):
            self.assertIsNone(designer.chrome_binary())
            self.assertIsNone(await designer.pdf_via_browser([page()]))

    async def test_a_missing_or_broken_browser_means_none_not_an_error(self):
        with mock.patch.dict(os.environ, {"CHROME_BIN": "/nonexistent/chrome", "DESIGN_PDF": "auto"}), mock.patch.object(designer.shutil, "which", lambda n: None), \
                mock.patch.object(designer.os.path, "exists", lambda p: p == "/nonexistent/chrome"):
            self.assertIsNone(await designer.pdf_via_browser([page()]))

    @unittest.skipUnless(designer.chrome_binary(), "no Chrome/Chromium on this machine")
    async def test_a_real_browser_renders_the_mockups_to_one_pdf(self):
        clean = [sanitize_html(page())[0], sanitize_html(page(headline="Second"))[0]]
        with mock.patch.dict(os.environ, {"DESIGN_PDF": "auto"}):
            data = await designer.pdf_via_browser(clean)
        self.assertIsNotNone(data)
        self.assertTrue(data.startswith(b"%PDF-"))
        self.assertGreaterEqual(designer.pdf_artifact(data, "x", "browser").payload["pages"], 2)


class RunTest(unittest.IsolatedAsyncioTestCase):
    def req(self, **kw):
        base = dict(task=TaskIn(title="Design the landing page for Pro", description="Dev will design the landing page"), meeting=MeetingIn(title="Launch sync", attendees=["dev"]),
                    source_lines=[SourceLine(speaker="dev", text="Keep it minimal.", at_task=True)], brand_note="Calm, plain, no jargon.")
        base.update(kw)
        return RunRequest(**base)

    async def go(self, r, *, data=None, htmls=None, check=None, asks=None):
        self.prompts, self.consults = [], 0
        data = data or brief_data()
        htmls = list(htmls or [page(), page()])

        async def fake_json(system, user, schema, **k):
            self.prompts.append(user)
            if schema is designer.BRIEF_SCHEMA:
                return data
            return asks if asks is not None else {"marketing": "Who is the audience?", "research": ""}

        async def fake_build(d, brief, task, model):
            return sanitize_html(htmls.pop(0))[0], []

        async def fake_consult(frm, to, q, rq, state, stack):
            self.consults += 1
            state.consultations.append(__import__("agents").Consultation(from_agent=frm, to_agent=to, question=q, answer="Busy product teams.", depth=1))

        async def fake_check(*a, **k): return check or Check(confidence=0.9)

        with mock.patch.object(designer, "chat_json", fake_json), mock.patch.object(designer, "build_mockup", fake_build), mock.patch.object(designer, "self_check", fake_check), \
                mock.patch.object(designer, "_consult", fake_consult), mock.patch.dict(os.environ, {"DESIGN_PDF": "board"}):
            return await designer.run_designer(r, _State(), Trace())

    async def test_a_run_delivers_two_mockups_a_brief_a_table_and_a_pdf(self):
        out = await self.go(self.req())
        kinds = [a.type for a in out.artifacts]
        self.assertEqual(kinds, ["html", "html", "markdown", "table", "pdf"])
        self.assertEqual([a.payload["direction"] for a in out.artifacts if a.type == "html"], ["A", "B"])
        brief = next(a for a in out.artifacts if a.type == "markdown").content
        for needle in ("Direction A: Bold night", "Direction B: Editorial day", "Meetings that follow up", "| Background | #0f1424 |"):
            self.assertIn(needle, brief)
        self.assertEqual(out.confidence, 0.9)
        self.assertIn("Approve direction A or B", out.notes)
        self.assertEqual(self.consults, 1)
        self.assertIn("design board", out.notes)

    async def test_the_run_stays_within_the_step_limit(self):
        out = await self.go(self.req())
        self.assertLessEqual(len(out.steps), 8)

    async def test_similar_directions_are_flagged_and_lower_confidence(self):
        near = {**DARK, "background": "#10162a", "accent": "#6f8fff"}
        out = await self.go(self.req(), data=brief_data(directions=[direction("A", DARK), direction("B", near)]))
        self.assertTrue(any("close in colour" in q for q in out.open_questions))
        self.assertLess(out.confidence, 0.9)

    async def test_contrast_fixes_are_documented_in_the_brief(self):
        bad = {**DARK, "text": "#2a3050"}
        out = await self.go(self.req(), data=brief_data(directions=[direction("A", bad), direction("B", LIGHT)]))
        brief = next(a for a in out.artifacts if a.type == "markdown").content
        self.assertIn("## Adjustments made", brief)
        self.assertTrue(any("adjusted automatically" in q for q in out.open_questions))

    async def test_no_brand_note_is_called_out(self):
        out = await self.go(self.req(brand_note=None))
        self.assertTrue(any("brand and voice note" in q for q in out.open_questions))
        out = await self.go(self.req())
        self.assertFalse(any("brand and voice note" in q for q in out.open_questions))

    async def test_at_most_one_question_per_specialist_and_none_when_the_brief_is_enough(self):
        await self.go(self.req(), asks={"marketing": "q1", "research": "q2"})
        self.assertEqual(self.consults, 2)
        await self.go(self.req(), asks={"marketing": "", "research": ""})
        self.assertEqual(self.consults, 0)

    async def test_a_missing_second_direction_is_filled_in_so_there_are_always_two(self):
        out = await self.go(self.req(), data=brief_data(directions=[direction("Only", DARK)]))
        self.assertEqual(len([a for a in out.artifacts if a.type == "html"]), 2)

    async def test_copy_that_names_the_team_is_re_asked_before_anything_is_rendered(self):
        bad = brief_data(copy={**COPY, "sections": [{"title": "Launch", "body": "Designed by Dev."}]})
        seq = [bad, brief_data()]

        async def fake_json(system, user, schema, **k):
            if schema is designer.BRIEF_SCHEMA:
                self.prompts.append(user)
                return seq.pop(0)
            return {"marketing": "", "research": ""}

        self.prompts = []

        async def fake_build(d, brief, task, model): return sanitize_html(page())[0], []
        async def fake_check(*a, **k): return Check(confidence=0.9)

        with mock.patch.object(designer, "chat_json", fake_json), mock.patch.object(designer, "build_mockup", fake_build), mock.patch.object(designer, "self_check", fake_check), \
                mock.patch.dict(os.environ, {"DESIGN_PDF": "board"}):
            out = await designer.run_designer(self.req(), _State(), Trace())
        self.assertEqual(len(self.prompts), 2)
        self.assertIn("names a team member", self.prompts[1])
        self.assertNotIn("Designed by Dev", next(a for a in out.artifacts if a.type == "markdown").content)

    async def test_a_blocking_self_check_triggers_one_repair_and_a_second_check(self):
        calls = {"brief": 0, "check": 0}

        async def fake_json(system, user, schema, **k):
            if schema is designer.BRIEF_SCHEMA:
                calls["brief"] += 1
                return brief_data()
            return {"marketing": "", "research": ""}

        async def fake_build(d, brief, task, model): return sanitize_html(page())[0], []

        async def fake_check(*a, **k):
            calls["check"] += 1
            return Check(confidence=0.5, blocking=["invented claim"]) if calls["check"] == 1 else Check(confidence=0.9)

        with mock.patch.object(designer, "chat_json", fake_json), mock.patch.object(designer, "build_mockup", fake_build), mock.patch.object(designer, "self_check", fake_check), \
                mock.patch.dict(os.environ, {"DESIGN_PDF": "board"}):
            out = await designer.run_designer(self.req(), _State(), Trace())
        self.assertEqual(calls, {"brief": 2, "check": 2})
        self.assertEqual(out.confidence, 0.9)
        self.assertLessEqual(len(out.steps), 8)
        self.assertEqual([a.type for a in out.artifacts].count("html"), 2)

    async def test_the_brand_note_reaches_the_model(self):
        await self.go(self.req(brand_note="Never use exclamation marks."))
        self.assertTrue(any("Never use exclamation marks." in p for p in self.prompts))


if __name__ == "__main__":
    unittest.main()
