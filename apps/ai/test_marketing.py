"""Marketing agent: calendar arithmetic, owner and KPI validation, plan/copy kinds, fit check and runs with the model stubbed.
Run: cd apps/ai && INTERNAL_SECRET=x .venv/bin/python -m unittest -v"""
import unittest
from datetime import date
from unittest import mock

import marketing
from agents import RunRequest, _State
from brief import DecisionIn, MeetingIn, NeighbourIn, SourceLine, TaskIn
from quality import Check
from runtrace import Trace

TODAY = date(2026, 11, 4)


class FakeDate(date):
    @classmethod
    def today(cls):
        return TODAY


def req(**kw) -> RunRequest:
    base = dict(
        task=TaskIn(title="Plan the Pro launch campaign", description="Priya will plan the launch campaign", assignee="priya", assigned_by="omar"),
        meeting=MeetingIn(title="Launch sync", date="2026-11-04", attendees=["priya", "omar"]),
        quote="Priya will plan the launch campaign.",
        source_lines=[SourceLine(speaker="omar", text="Pro is $49 per month and we launch on November 22.", at_task=True)],
        decisions=[DecisionIn(key="launch date", value="November 22", previous=["November 15"]), DecisionIn(key="pro plan price", value="$49 per month")],
        neighbours=[NeighbourIn(title="Design the banner", assignee="sam")])
    base.update(kw)
    return RunRequest(**base)


class DateTest(unittest.TestCase):
    def test_forms_people_actually_say(self):
        ref = date(2026, 11, 4)
        for text, want in [("2026-11-22", date(2026, 11, 22)), ("November 22", date(2026, 11, 22)), ("Nov 22nd, 2027", date(2027, 11, 22)), ("22 November", date(2026, 11, 22)),
                           ("the 22nd of Nov", date(2026, 11, 22)), ("Launch on dec 1st", date(2026, 12, 1))]:
            self.assertEqual(marketing.parse_date(text, ref), want, text)

    def test_a_year_less_date_in_the_past_means_next_year(self):
        self.assertEqual(marketing.parse_date("January 5", date(2026, 12, 1)), date(2027, 1, 5))

    def test_nonsense_is_not_a_date(self):
        for t in ("soon", "February 30", "after the board meeting", ""):
            self.assertIsNone(marketing.parse_date(t, TODAY), t)

    def test_the_current_launch_decision_wins_and_history_is_ignored(self):
        d, text = marketing.launch_date(req(), TODAY)
        self.assertEqual((d, text), (date(2026, 11, 22), "November 22"))
        self.assertIsNone(marketing.launch_date(req(decisions=[DecisionIn(key="price", value="$49")]), TODAY)[0])


class PlanLogicTest(unittest.TestCase):
    TEAM = {"priya": "priya", "omar": "omar", "sam": "sam"}

    def test_owners_must_be_real_people(self):
        phases, _ = marketing.clean_phases([{"name": "Teaser", "start_days_before": 14, "end_days_before": 7, "owner": "Priya", "deliverable": "d"},
                                            {"name": "PR", "start_days_before": 10, "end_days_before": 5, "owner": "Elon Musk", "deliverable": "d"}], self.TEAM, 30)
        self.assertEqual([p["owner"] for p in phases], ["priya", "Unassigned"])

    def test_phases_that_start_before_today_are_dropped_not_squeezed(self):
        phases, slips = marketing.clean_phases([{"name": "Research", "start_days_before": 45, "end_days_before": 30, "owner": "priya", "deliverable": "x"},
                                                {"name": "Teaser", "start_days_before": 14, "end_days_before": 7, "owner": "priya", "deliverable": "y"}], self.TEAM, 18)
        self.assertEqual([p["name"] for p in phases], ["Teaser"])
        self.assertEqual(len(slips), 1)
        self.assertIn("only 18 remain", slips[0])

    def test_malformed_and_negative_offsets_are_repaired_or_skipped(self):
        phases, _ = marketing.clean_phases([{"name": "A", "start_days_before": -3, "end_days_before": 9, "owner": "x", "deliverable": ""}, {"name": "B"}, {"name": "C", "start_days_before": "7", "end_days_before": 2}], self.TEAM, None)
        self.assertEqual([(p["name"], p["start"], p["end"]) for p in phases], [("A", 0, 0), ("C", 7, 2)])

    def test_without_a_launch_date_nothing_is_dropped(self):
        _, slips = marketing.clean_phases([{"name": "A", "start_days_before": 90, "end_days_before": 80, "owner": "x", "deliverable": ""}], self.TEAM, None)
        self.assertEqual(slips, [])

    def test_dates_are_counted_back_from_the_real_launch_date(self):
        phases = [{"name": "Launch", "start": 0, "end": 0, "owner": "o", "deliverable": "d"}, {"name": "Teaser", "start": 14, "end": 7, "owner": "o", "deliverable": "d"}]
        rows = marketing.timeline_rows(phases, date(2026, 11, 22))
        self.assertEqual(rows[0][:3], ["Teaser", "Nov 8, 2026", "Nov 15, 2026"])  # sorted by start, earliest first
        self.assertEqual(rows[1][:3], ["Launch", "Nov 22, 2026", "Nov 22, 2026"])
        self.assertEqual(marketing.timeline_rows(phases, None)[0][1:3], ["T-14d", "T-7d"])

    def test_kpis_are_assumptions_unless_the_figures_are_really_in_the_brief(self):
        ground = "Pro is $49 per month. Competitors convert at 3.2% on average."
        out = marketing.label_kpis([
            {"metric": "Price point", "target": "$49", "basis": "brief"},
            {"metric": "Signups", "target": "5,000", "basis": "brief"},        # claimed from the brief but not there
            {"metric": "Conversion", "target": "3.2%", "basis": "research"},
            {"metric": "NPS", "target": "high", "basis": "brief"},             # no figure to source
            {"metric": "Reach", "target": "10k", "basis": "wizard"}], ground)
        self.assertEqual([k["basis"] for k in out], ["brief", "assumption", "research", "assumption", "assumption"])

    def test_assembled_plan_labels_assumptions_and_says_when_no_budget_was_discussed(self):
        md = marketing.assemble({"pillars": ["One clear message"], "channels": [{"name": "Email", "reason": "owned"}], "budget": "Not discussed"},
                                {"title": "Pro launch plan", "summary": "S.", "positioning": "P.", "risks": "- r"},
                                [["Teaser", "Nov 8, 2026", "Nov 15, 2026", "priya", "d"]], [{"metric": "Signups", "target": "5,000", "basis": "assumption"}], date(2026, 11, 22), "November 22", ["Research (needed more time)"], False)
        for needle in ("# Pro launch plan", "November 22, 2026", "| Teaser |", "| Signups | 5,000 | Assumption |", "No budget was discussed", "What does not fit before launch", "- Research (needed more time)"):
            self.assertIn(needle, md)


class RunTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.p = mock.patch.object(marketing, "date", FakeDate)
        self.p.start()
        self.seen = {"prompts": [], "consults": 0, "plans": 0, "prose": 0}

    def tearDown(self):
        self.p.stop()

    async def go(self, r, *, kind="plan", plans=None, proses=None, checks=None, research_questions=None):
        plans = list(plans or [self.plan()])
        proses = list(proses or [self.prose()])
        checks = list(checks or [Check(confidence=0.9)])

        async def fake_json(system, user, schema, **k):
            self.seen["prompts"].append(system + "\n" + user)
            if schema is marketing.KIND_SCHEMA:
                return {"kind": kind, "research_questions": research_questions or []}
            if schema is marketing.PLAN_SCHEMA:
                self.seen["plans"] += 1
                return plans.pop(0) if len(plans) > 1 else plans[0]
            self.seen["prose"] += 1
            return proses.pop(0) if len(proses) > 1 else proses[0]

        async def fake_text(system, user, **k): return "## Press release\nWe launch Pro on November 22 at $49 per month."
        async def fake_check(*a, **k): return checks.pop(0) if len(checks) > 1 else checks[0]

        async def fake_consult(frm, to, q, rq, state, stack):
            self.seen["consults"] += 1
            state.consultations.append(__import__("agents").Consultation(from_agent=frm, to_agent=to, question=q, answer="Competitors lead with annual discounts.", depth=1))

        with mock.patch.object(marketing, "chat_json", fake_json), mock.patch.object(marketing, "complete_text", fake_text), \
                mock.patch.object(marketing, "self_check", fake_check), mock.patch.object(marketing, "_consult", fake_consult):
            return await marketing.run_marketing(r, _State(), Trace())

    def plan(self, phases=None, **kw):
        base = {"goal": "g", "audience": "busy teams", "positioning": "p", "pillars": ["Saves time"], "channels": [{"name": "Email", "reason": "owned"}],
                "phases": phases or [{"name": "Teaser", "start_days_before": 14, "end_days_before": 7, "owner": "priya", "deliverable": "teaser email"},
                                     {"name": "Launch", "start_days_before": 0, "end_days_before": 0, "owner": "omar", "deliverable": "announce"}],
                "kpis": [{"metric": "Price", "target": "$49", "basis": "brief"}, {"metric": "Signups", "target": "5,000", "basis": "brief"}],
                "budget": "Not discussed", "copy_pieces": []}
        base.update(kw)
        return base

    def prose(self, **kw):
        return {**{"title": "Pro launch plan", "summary": "Launch Pro on November 22 at $49 per month.", "positioning": "For busy teams.", "risks": "- Date risk"}, **kw}

    async def test_a_full_plan_is_anchored_to_the_decided_launch_date_and_real_owners(self):
        out = await self.go(req(), research_questions=["How do competitors position annual plans?"])
        plan = next(a for a in out.artifacts if a.title == "Marketing plan").content
        table = next(a for a in out.artifacts if a.type == "table")
        self.assertEqual(table.payload["rows"][0][:4], ["Teaser", "Nov 8, 2026", "Nov 15, 2026", "priya"])
        self.assertEqual(table.payload["rows"][1][1], "Nov 22, 2026")
        self.assertIn("November 22, 2026", plan)
        self.assertIn("| Signups | 5,000 | Assumption |", plan)      # claimed from the brief, not in it
        self.assertIn("| Price | $49 | From the brief |", plan)
        self.assertEqual(self.seen["consults"], 1)
        self.assertEqual(out.confidence, 0.9)
        self.assertTrue(any("KPI targets are assumptions" in q for q in out.open_questions))
        self.assertTrue(any("No budget was discussed" in q for q in out.open_questions))

    async def test_a_plan_that_does_not_fit_is_reduced_and_says_so(self):
        long_plan = self.plan(phases=[{"name": "Research", "start_days_before": 60, "end_days_before": 40, "owner": "priya", "deliverable": "r"},
                                      {"name": "Build assets", "start_days_before": 40, "end_days_before": 20, "owner": "omar", "deliverable": "a"},
                                      {"name": "Teaser", "start_days_before": 14, "end_days_before": 7, "owner": "priya", "deliverable": "t"},
                                      {"name": "Launch", "start_days_before": 0, "end_days_before": 0, "owner": "omar", "deliverable": "l"}])
        out = await self.go(req(), plans=[long_plan])  # 18 days left until Nov 22
        plan = next(a for a in out.artifacts if a.title == "Marketing plan").content
        self.assertIn("What does not fit before launch", plan)
        self.assertNotIn("| Research |", plan)
        self.assertIn("| Teaser |", plan)
        self.assertTrue(any("does not fit before launch (18 days left)" in q for q in out.open_questions))
        self.assertIn("reduced", out.notes)
        self.assertLess(out.confidence, 0.9)
        self.assertEqual(self.seen["plans"], 1)  # enough still fits, so no re-plan

    async def test_when_almost_nothing_fits_the_agent_replans_for_the_time_left(self):
        impossible = self.plan(phases=[{"name": "Big", "start_days_before": 90, "end_days_before": 30, "owner": "priya", "deliverable": "x"}])
        small = self.plan(phases=[{"name": "Quick teaser", "start_days_before": 10, "end_days_before": 3, "owner": "priya", "deliverable": "t"},
                                  {"name": "Launch", "start_days_before": 0, "end_days_before": 0, "owner": "omar", "deliverable": "l"}])
        out = await self.go(req(), plans=[impossible, small])
        self.assertEqual(self.seen["plans"], 2)
        self.assertIn("Only 18 days remain", " ".join(self.seen["prompts"]))
        self.assertIn("| Quick teaser |", next(a for a in out.artifacts if a.title == "Marketing plan").content)

    async def test_without_a_launch_date_the_timeline_is_relative_and_confidence_drops(self):
        out = await self.go(req(decisions=[DecisionIn(key="pro plan price", value="$49 per month")]))
        table = next(a for a in out.artifacts if a.type == "table")
        self.assertEqual(table.payload["rows"][0][1], "T-14d")
        self.assertTrue(any("No launch date" in q for q in out.open_questions))
        self.assertLess(out.confidence, 0.9)

    async def test_copy_tasks_deliver_the_text_not_a_plan(self):
        out = await self.go(req(task=TaskIn(title="Write the launch press release")), kind="copy")
        self.assertEqual([a.type for a in out.artifacts], ["markdown"])
        self.assertEqual(out.artifacts[0].title, "Launch copy")
        self.assertIn("Press release", out.artifacts[0].content)
        self.assertEqual(self.seen["prose"], 0)
        self.assertIn("Copy is ready", out.notes)

    async def test_both_gives_a_plan_and_the_copy(self):
        out = await self.go(req(), kind="both", plans=[self.plan(copy_pieces=["press release"])])
        self.assertEqual([a.title for a in out.artifacts if a.type == "markdown"], ["Marketing plan", "Copy"])

    async def test_a_figure_that_is_neither_sourced_nor_labelled_triggers_one_repair(self):
        bad = self.prose(summary="We expect $120,000 in revenue and 4,000 signups.")
        good = self.prose(summary="Launch Pro on November 22 at $49 per month. Revenue target is an assumption.")
        out = await self.go(req(), proses=[bad, good])
        self.assertEqual(self.seen["prose"], 2)
        plan = next(a for a in out.artifacts if a.title == "Marketing plan").content
        self.assertNotIn("$120,000", plan)

    async def test_the_brand_note_reaches_the_model(self):
        await self.go(req(brand_note="Friendly, never salesy. Say 'teams' not 'users'."))
        self.assertTrue(any("Friendly, never salesy" in p for p in self.seen["prompts"]))

    async def test_at_most_two_research_questions_are_asked(self):
        await self.go(req(), research_questions=["q1", "q2", "q3", "q4"])
        self.assertEqual(self.seen["consults"], 2)


if __name__ == "__main__":
    unittest.main()
