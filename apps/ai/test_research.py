"""Research agent: privacy scrubbing, citation verification and full runs with the model and search stubbed.
Run: cd apps/ai && INTERNAL_SECRET=x .venv/bin/python -m unittest -v"""
import os
import unittest
from unittest import mock

import research
from agents import RunRequest, _State
from brief import DecisionIn, MeetingIn, NeighbourIn, SourceLine, TaskIn
from quality import Check
from runtrace import Trace


def req(**kw) -> RunRequest:
    base = dict(
        task=TaskIn(title="Compare competitor pricing", description="Priya will compare Acme and Globex pricing", assignee="priya", assigned_by="omar"),
        meeting=MeetingIn(title="Launch sync", attendees=["priya", "omar"]),
        quote="Priya will compare Acme and Globex pricing before launch.",
        source_lines=[SourceLine(speaker="omar", text="Acme and Globex are the ones to watch.", at_task=True)],
        decisions=[DecisionIn(key="pro plan price", value="$49 per month")],
        neighbours=[NeighbourIn(title="Design the banner")])
    base.update(kw)
    return RunRequest(**base)


SEARCHES = [{"query": "Acme Globex pricing", "results": [
    {"title": "Acme pricing", "url": "https://www.acme.example/pricing/"},
    {"title": "Globex plans", "url": "https://globex.example/plans?utm=x"},
    {"title": "Review of both", "url": "https://blog.reviews.example/acme-vs-globex"}]}]


class ScrubTest(unittest.TestCase):
    def test_nothing_private_survives(self):
        r = req()
        q = research.scrub("Priya omar pricing for priya@corp.com +91 98765 43210 at $49 per month, order 1234567, see https://internal.corp/x Acme", r)
        for bad in ("priya", "omar", "@", "98765", "$49", "1234567", "internal"):
            self.assertNotIn(bad, q.lower())
        self.assertIn("Acme", q)

    def test_queries_are_generic_distinct_and_capped(self):
        qs = research.clean_queries(["Acme pricing tiers", "acme pricing tiers", "priya", "Globex plans 2026", "a", "x y z", "q1 q2", "q3 q4", "q5 q6", "q7 q8"], req())
        self.assertEqual(qs[0], "Acme pricing tiers")
        self.assertNotIn("priya", [q.lower() for q in qs])
        self.assertEqual(len(qs), research.MAX_SEARCHES)
        self.assertEqual(len({q.lower() for q in qs}), len(qs))


class CitationTest(unittest.TestCase):
    def setUp(self):
        self.r = research.Retrieved(SEARCHES)

    def test_exact_and_normalised_matches(self):
        self.assertEqual(self.r.resolve("https://acme.example/pricing")["title"], "Acme pricing")  # www and trailing slash
        self.assertEqual(self.r.resolve("http://GLOBEX.example/plans")["title"], "Globex plans")  # query ignored

    def test_a_bare_domain_resolves_to_a_retrieved_page_on_that_site(self):
        self.assertEqual(self.r.resolve("https://globex.example")["url"], "https://globex.example/plans?utm=x")
        self.assertEqual(self.r.resolve("https://reviews.example")["title"], "Review of both")  # parent domain of a retrieved subdomain

    def test_only_http_pages_are_ever_retrieved(self):
        r = research.Retrieved([{"query": "q", "results": [{"title": "x", "url": "javascript:alert(1)"}, {"title": "y", "url": "data:text/html,hi"}, {"title": "ok", "url": "http://plain.example/a"}]}])
        self.assertEqual([i["url"] for i in r.items], ["http://plain.example/a"])

    def test_unknown_sites_do_not_resolve(self):
        self.assertIsNone(self.r.resolve("https://made-up.example/pricing"))
        self.assertIsNone(self.r.resolve("https://acme.example.evil.com/pricing"))

    def test_links_become_numbered_markers_and_unverified_ones_are_dropped(self):
        text = "Acme is [cheaper](https://acme.example) than Globex ([plans](https://globex.example/plans)); again [Acme](https://www.acme.example/pricing). Also [made up](https://fake.example/x) and bare https://nowhere.example/y ."
        out, sources, dropped = research.number_citations(text, self.r)
        self.assertIn("cheaper [1]", out)
        self.assertIn("plans [2]", out)
        self.assertIn("Acme [1]", out)  # same page, same number
        self.assertIn("made up", out)
        self.assertNotIn("fake.example", out)
        self.assertNotIn("nowhere.example", out)
        self.assertEqual((len(sources), dropped), (2, 2))
        self.assertEqual([s["title"] for s in sources], ["Acme pricing", "Globex plans"])

    def test_the_report_can_only_cite_known_numbers_and_never_a_raw_url(self):
        out = research.strip_unknown_markers("A [1] B [2] C [7] see https://x.example/y", 2)
        self.assertEqual(out.replace("  ", " ").strip(), "A [1] B [2] C see")

    def test_sources_section_is_honest_when_there_is_no_web(self):
        self.assertIn("No web search was used", research.sources_markdown([], "2026-11-04", False, "Web lookups are switched off."))
        txt = research.sources_markdown([{"title": "T", "url": "https://a.example/p"}], "2026-11-04", True)
        self.assertIn("1. T - https://a.example/p", txt)
        self.assertIn("did not open the pages", txt)


class RunTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        os.environ.pop("WEB_SEARCH", None)
        self.calls = {"respond": [], "write": 0}

    async def run_it(self, r, *, web=None, web_error=None, checks=None, focus=None):
        focus = focus or {"question": "How do Acme and Globex price their plans?", "sub_questions": ["What does Priya's Acme plan cost?"], "queries": ["Acme pricing tiers", "Globex plans pricing priya@corp.com"],
                          "already_decided": ["pro plan price is $49"], "needs_web": True}
        checks = list(checks or [Check(confidence=0.9)])

        async def fake_focus(*a, **k): return focus

        async def fake_respond(instructions, user, **k):
            self.calls["respond"].append((user, k))
            if web_error:
                raise RuntimeError(web_error)
            return web or {"text": "Acme costs $20 ([page](https://acme.example)). Globex costs $30 ([plans](https://globex.example/plans)) and Zed costs $5 ([zed](https://zed.example/p)).", "searches": SEARCHES, "citations": [], "status": "completed"}

        async def fake_write(*a, **k):
            self.calls["write"] += 1
            return "# R\n## Summary\nAcme is cheaper [1] and Globex is pricier [2] [9].\n## Risks and unknowns\nZed unknown."

        async def fake_check(*a, **k): return checks.pop(0) if len(checks) > 1 else checks[0]

        with mock.patch.object(research, "chat_json", fake_focus), mock.patch.object(research, "respond", fake_respond), \
                mock.patch.object(research, "complete_text", fake_write), mock.patch.object(research, "self_check", fake_check):
            return await research.run_research(r, _State(), Trace())

    async def test_web_run_keeps_only_retrieved_sources_and_cleans_the_report(self):
        out = await self.run_it(req())
        report = out.artifacts[0].content
        self.assertIn("## Sources", report)
        self.assertIn("https://www.acme.example/pricing/", report)
        self.assertNotIn("zed.example", report)  # cited but never retrieved
        self.assertNotIn("[9]", report)  # unknown marker removed
        links = next(a for a in out.artifacts if a.type == "link")
        self.assertEqual([i["host"] for i in links.payload["items"]], ["acme.example", "globex.example"])
        self.assertTrue(any("not among the pages actually retrieved" in q for q in out.open_questions))
        self.assertEqual(out.confidence, 0.9)

    async def test_search_only_sees_scrubbed_public_terms(self):
        await self.run_it(req())
        user, kw = self.calls["respond"][0]
        for bad in ("priya", "omar", "@", "$49", "corp.com"):
            self.assertNotIn(bad, user.lower())
        self.assertTrue(kw["search"])
        self.assertLessEqual(kw["max_searches"], 5)
        self.assertIn("Acme pricing tiers", user)

    async def test_web_switched_off_means_no_search_and_an_honest_note(self):
        out = await self.run_it(req(allow_web=False))
        self.assertEqual(self.calls["respond"], [])
        self.assertIn("No web search was used", out.artifacts[0].content)
        self.assertFalse(any(a.type == "link" for a in out.artifacts))
        self.assertTrue(any("off for this project" in q for q in out.open_questions))
        self.assertLess(out.confidence, 0.9)

    async def test_env_switch_also_disables_web(self):
        os.environ["WEB_SEARCH"] = "off"
        try:
            await self.run_it(req())
        finally:
            os.environ.pop("WEB_SEARCH")
        self.assertEqual(self.calls["respond"], [])

    async def test_a_search_failure_degrades_to_a_project_only_report(self):
        out = await self.run_it(req(), web_error="boom")
        self.assertIn("No web search was used", out.artifacts[0].content)
        self.assertTrue(any("Web search was unavailable" in q for q in out.open_questions))
        self.assertTrue(out.artifacts)

    async def test_a_question_the_project_can_answer_skips_the_web(self):
        out = await self.run_it(req(), focus={"question": "What did we decide?", "sub_questions": [], "queries": [], "already_decided": [], "needs_web": False})
        self.assertEqual(self.calls["respond"], [])
        self.assertIn("answered from project context", out.artifacts[0].content)

    async def test_fewer_than_two_sources_lowers_confidence_and_says_so(self):
        one = {"text": "Acme costs $20 ([page](https://acme.example)).", "searches": SEARCHES, "citations": [], "status": "completed"}
        out = await self.run_it(req(), web=one)
        self.assertTrue(any("Fewer than two" in q for q in out.open_questions))
        self.assertLess(out.confidence, 0.9)

    async def test_failed_check_gets_one_repair(self):
        out = await self.run_it(req(), checks=[Check(confidence=0.5, blocking=["ignores the $49 decision"]), Check(confidence=0.85)])
        self.assertEqual(self.calls["write"], 2)
        self.assertEqual(out.confidence, 0.85)


if __name__ == "__main__":
    unittest.main()
