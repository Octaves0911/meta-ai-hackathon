"""Streaming chat, screenshots, tool-calling answers: the service endpoints with the model stubbed.
Run: cd apps/ai && INTERNAL_SECRET=x .venv/bin/python -m unittest -v"""
import json
import os
import unittest
from unittest import mock

from fastapi.testclient import TestClient

import agents
import insights

os.environ.setdefault("INTERNAL_SECRET", "x")
import main  # noqa: E402  (needs INTERNAL_SECRET)

H = {"x-internal-secret": os.environ["INTERNAL_SECRET"]}
PNG = "data:image/png;base64,iVBORw0KGgo="
BRIEF = {"task": {"title": "Plan the launch"}, "meeting": {"title": "Sync"}, "message": "Why those dates?", "current_output": "# Plan", "revision": 0}


class StreamEndpointTest(unittest.TestCase):
    def setUp(self):
        self.env = mock.patch.dict(os.environ, {"AGENTS_MODE": "mock"})
        self.env.start()
        self.client = TestClient(main.app)

    def tearDown(self):
        self.env.stop()

    def test_the_reply_streams_as_ndjson_deltas_then_one_done_line(self):
        r = self.client.post("/agents/marketing/chat/stream", json=BRIEF, headers=H)
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.headers["content-type"].startswith("application/x-ndjson"))
        lines = [json.loads(x) for x in r.text.splitlines() if x.strip()]
        self.assertGreater(len([x for x in lines if x["t"] == "delta"]), 2)
        self.assertEqual(lines[-1]["t"], "done")
        self.assertEqual("".join(x["text"] for x in lines if x["t"] == "delta").strip(), lines[-1]["reply"].strip())
        self.assertIn(lines[-1]["kind"], ("ask", "change", "clarify"))

    def test_it_needs_the_internal_secret_and_a_valid_agent(self):
        self.assertEqual(self.client.post("/agents/marketing/chat/stream", json=BRIEF).status_code, 401)
        self.assertEqual(self.client.post("/agents/nobody/chat/stream", json=BRIEF, headers=H).status_code, 422)

    def test_errors_end_the_stream_with_an_error_line_not_a_hang(self):
        async def boom(name, req):
            raise agents.HTTPException(status_code=502, detail="LLM returned an unexpected response")
            yield  # pragma: no cover
        with mock.patch.object(agents, "chat_stream_with_agent", boom):
            r = self.client.post("/agents/marketing/chat/stream", json=BRIEF, headers=H)
        last = json.loads(r.text.splitlines()[-1])
        self.assertEqual((last["t"], last["status"]), ("error", 502))


class ScreenshotTest(unittest.IsolatedAsyncioTestCase):
    async def test_attached_screenshots_reach_the_model_and_the_prompt_says_so(self):
        seen = {}

        async def fake_chat_json(system, user, schema, **kw):
            seen.update(user=user, images=kw.get("images"), system=system)
            return {"kind": "change", "reply": "That is a null check.", "proposed_change": "Guard against null."}

        with mock.patch.object(agents, "chat_json", fake_chat_json), mock.patch.dict(os.environ, {"AGENTS_MODE": ""}):
            out = await agents.chat_with_agent("code", agents.ChatRequest(**{**BRIEF, "images": [PNG]}))
        self.assertEqual(seen["images"], [PNG])
        self.assertIn("attached the image", seen["user"])
        self.assertIn("screenshot", seen["system"])
        self.assertEqual(out.kind, "change")

    def test_at_most_four_images_are_accepted(self):
        with self.assertRaises(Exception):
            agents.ChatRequest(**{**BRIEF, "images": [PNG] * 5})
        with self.assertRaises(Exception):
            agents.RunRequest(**{"task": {"title": "t"}, "meeting": {"title": "m"}, "images": [PNG] * 5})


class AnswerToolsTest(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self.base = {"question": "Who owns the pricing research?", "context": []}

    def test_without_a_tool_url_the_answer_uses_the_sources_only(self):
        async def fake_json(system, user, **kw):
            return {"answer": "From sources.", "used_ids": []}
        with mock.patch.object(insights, "complete_json", fake_json):
            r = self.client.post("/answer", json=self.base, headers=H)
        self.assertEqual(r.json(), {"answer": "From sources.", "tools_used": [], "used_ids": []})

    def test_with_a_tool_url_the_model_can_look_things_up_and_the_tools_used_are_reported(self):
        ran = []

        async def fake_tools(system, user, tools, run_tool, **kw):
            ran.append(sorted(t["function"]["name"] for t in tools))
            await run_tool("list_tasks", {"status": "open"})
            return '{"answer": "Sam owns it.", "used_ids": ["c1"]}', [{"name": "list_tasks", "args": {}, "ok": True}, {"name": "search_project", "args": {}, "ok": False}]

        calls = []

        class FakeClient:
            def __init__(self, **kw): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *a): return False
            async def post(self, url, json=None, headers=None):
                calls.append((url, json, headers))
                class R:
                    def raise_for_status(self): pass
                    def json(self): return [{"title": "Research pricing", "owner": "sam"}]
                return R()

        body = {**self.base, "context": [{"id": "c1", "label": "Meeting", "text": "Sam will research pricing", "score": 0.8, "source_type": "transcript"}],
                "tool_url": "http://backend/api/internal/ai-tools", "project_id": "p1"}
        with mock.patch.object(insights, "chat_with_tools", fake_tools), mock.patch.object(insights.httpx, "AsyncClient", FakeClient):
            r = self.client.post("/answer", json=body, headers=H)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), {"answer": "Sam owns it.", "tools_used": ["list_tasks"], "used_ids": ["c1"]})   # only tools that worked are reported
        self.assertEqual(ran, [["list_decisions", "list_tasks", "search_project"]])
        url, sent, headers = calls[0]
        self.assertEqual((url, sent), ("http://backend/api/internal/ai-tools", {"project_id": "p1", "tool": "list_tasks", "args": {"status": "open"}}))
        self.assertEqual(headers["x-internal-secret"], os.environ["INTERNAL_SECRET"])

    def test_a_plain_text_final_answer_is_still_accepted(self):
        async def fake_tools(system, user, tools, run_tool, **kw):
            return "Sam owns it.", []
        with mock.patch.object(insights, "chat_with_tools", fake_tools):
            r = self.client.post("/answer", json={**self.base, "tool_url": "http://b/x", "project_id": "p"}, headers=H)
        self.assertEqual(r.json()["answer"], "Sam owns it.")


if __name__ == "__main__":
    unittest.main()
