"""Gateway tests with a stubbed transport (no network, no key). Run: cd apps/ai && python3 -m unittest -v"""
import os
import unittest
from unittest import mock

import httpx
from fastapi import HTTPException

import llm

REAL_CLIENT = httpx.AsyncClient


def stub(handler):
    """Make llm._call talk to `handler` instead of the network."""
    return mock.patch.object(llm.httpx, "AsyncClient", lambda **kw: REAL_CLIENT(transport=httpx.MockTransport(handler), **kw))


def ok(text: str) -> httpx.Response:
    return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": text}}]})


class GatewayTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        env = {"LLM_API_KEY": "k-test"}
        self.patch = mock.patch.dict(os.environ, env, clear=False)
        self.patch.start()
        for name in ("LLM_MODEL", "LLM_API_URL", "LLM_REASONING_EFFORT", "MODEL_API_KEY"):
            os.environ.pop(name, None)
        self.sleep = mock.patch.object(llm.asyncio, "sleep", mock.AsyncMock())
        self.sleep.start()

    def tearDown(self):
        self.sleep.stop()
        self.patch.stop()

    async def test_request_shape_is_meta_chat_completions(self):
        seen = {}

        def handler(req: httpx.Request) -> httpx.Response:
            seen["url"], seen["auth"] = str(req.url), req.headers["authorization"]
            seen["body"] = __import__("json").loads(req.content)
            return ok("hello")

        with stub(handler):
            out = await llm.complete_text("be brief", "hi", max_tokens=50)
        self.assertEqual(out, "hello")
        self.assertEqual(seen["url"], "https://api.meta.ai/v1/chat/completions")
        self.assertEqual(seen["auth"], "Bearer k-test")
        body = seen["body"]
        self.assertEqual(body["model"], "muse-spark-1.3")
        self.assertEqual(body["max_completion_tokens"], 50 + llm.REASONING_HEADROOM)
        self.assertNotIn("max_tokens", body)
        self.assertEqual(body["reasoning_effort"], "minimal")
        self.assertEqual([m["role"] for m in body["messages"]], ["system", "user"])
        self.assertIn("untrusted_source", body["messages"][0]["content"])

    async def test_model_and_reasoning_effort_come_from_env(self):
        os.environ["LLM_MODEL"] = "muse-spark-1.3-contributor"
        os.environ["LLM_REASONING_EFFORT"] = "low"
        seen = {}

        def handler(req):
            seen.update(__import__("json").loads(req.content))
            return ok("x")

        with stub(handler):
            await llm.complete_text("s", "u")
        self.assertEqual(seen["model"], "muse-spark-1.3-contributor")
        self.assertEqual(seen["reasoning_effort"], "low")

    async def test_meta_key_name_from_their_docs_is_accepted(self):
        del os.environ["LLM_API_KEY"]
        os.environ["MODEL_API_KEY"] = "m-key"
        with stub(lambda req: ok("x") if req.headers["authorization"] == "Bearer m-key" else httpx.Response(401)):
            self.assertEqual(await llm.complete_text("s", "u"), "x")

    async def test_missing_key_is_503(self):
        del os.environ["LLM_API_KEY"]
        with self.assertRaises(HTTPException) as cm:
            await llm.complete_text("s", "u")
        self.assertEqual(cm.exception.status_code, 503)

    async def test_json_is_extracted_and_malformed_output_retried_once(self):
        replies = iter(["no json here", 'sure: {"a": 1} done'])
        with stub(lambda req: ok(next(replies))):
            self.assertEqual(await llm.complete_json("s", "u"), {"a": 1})

    async def test_rate_limit_is_retried_then_succeeds(self):
        calls = iter([httpx.Response(429, headers={"retry-after": "2"}), ok("fine")])
        with stub(lambda req: next(calls)):
            self.assertEqual(await llm.complete_text("s", "u"), "fine")
        self.assertGreaterEqual(self.sleep.target.sleep.await_args.args[0], 2)

    async def test_persistent_failure_is_502(self):
        with stub(lambda req: httpx.Response(500)):
            with self.assertRaises(HTTPException) as cm:
                await llm.complete_text("s", "u")
        self.assertEqual(cm.exception.status_code, 502)

    async def test_empty_content_from_exhausted_budget_is_502(self):
        empty = {"choices": [{"finish_reason": "length", "message": {"role": "assistant", "content": None}}]}
        with stub(lambda req: httpx.Response(200, json=empty)):
            with self.assertRaises(HTTPException) as cm:
                await llm.complete_text("s", "u")
        self.assertEqual(cm.exception.status_code, 502)

    async def test_unexpected_shape_is_502(self):
        with stub(lambda req: httpx.Response(200, json={"content": [{"text": "anthropic shape"}]})):
            with self.assertRaises(HTTPException) as cm:
                await llm.complete_text("s", "u")
        self.assertEqual(cm.exception.status_code, 502)




class CachingTest(unittest.IsolatedAsyncioTestCase):
    """Prompt caching is automatic on Meta's API; we name the shared prefix and report how much of each prompt was reused."""

    def setUp(self):
        self.patch = mock.patch.dict(os.environ, {"LLM_API_KEY": "k-test"}, clear=False)
        self.patch.start()
        for name in ("LLM_MODEL", "LLM_API_URL", "LLM_RESPONSES_URL", "LLM_REASONING_EFFORT", "MODEL_API_KEY"):
            os.environ.pop(name, None)
        llm.set_cache_key()          # no key unless a test sets one

    def tearDown(self):
        llm.set_cache_key()
        self.patch.stop()

    async def test_no_cache_key_is_sent_unless_one_is_set(self):
        seen = []

        def handler(req):
            seen.append(__import__("json").loads(req.content))
            return ok("x")

        with stub(handler):
            await llm.complete_text("s", "u", max_tokens=20)
            llm.set_cache_key("agent", "research", "Project One")
            await llm.complete_text("s", "u", max_tokens=20)
        self.assertNotIn("prompt_cache_key", seen[0])
        self.assertEqual(seen[1]["prompt_cache_key"], "agent:research:Project-One")

    def test_the_key_is_short_and_made_of_safe_characters(self):
        llm.set_cache_key("agent", "x" * 500, "a b/c?d=e")
        k = llm._cache_key.get()
        self.assertLessEqual(len(k), 128)
        self.assertRegex(k, r"^[\w.:-]+$")
        llm.set_cache_key(None, "")
        self.assertIsNone(llm._cache_key.get())

    async def test_cached_tokens_are_counted_from_both_api_shapes_and_cost_is_unchanged(self):
        usage = llm.begin_usage()
        chat = {"usage": {"prompt_tokens": 3000, "completion_tokens": 100, "prompt_tokens_details": {"cached_tokens": 2929}}}
        resp = {"usage": {"input_tokens": 2000, "output_tokens": 50, "input_tokens_details": {"cached_tokens": 1024}}}
        llm._record("muse-spark-1.3", chat)
        llm._record("muse-spark-1.3", resp, searches=1)
        llm._record("muse-spark-1.3", {"usage": {"prompt_tokens": 10, "completion_tokens": 1}})      # no details at all
        llm._record("muse-spark-1.3", {"usage": {"prompt_tokens": 10, "completion_tokens": 1, "prompt_tokens_details": {"cached_tokens": 999}}})  # never more than the prompt
        self.assertEqual(usage["cached_tokens"], 2929 + 1024 + 0 + 10)
        self.assertEqual(usage["prompt_tokens"], 3000 + 2000 + 10 + 10)
        full = (3000 * 1.25 + 100 * 4.25 + 2000 * 1.25 + 50 * 4.25 + 10 * 1.25 + 1 * 4.25 + 10 * 1.25 + 1 * 4.25) / 1_000_000 + 0.0025
        self.assertAlmostEqual(usage["cost_usd"], full, delta=0.00001)                           # cost stays an upper bound at list price

    async def test_the_responses_call_carries_the_key_too(self):
        seen = {}

        def handler(req):
            seen["body"] = __import__("json").loads(req.content)
            return httpx.Response(200, json={"status": "completed", "output": [{"type": "message", "content": [{"type": "output_text", "text": "hi", "annotations": []}]}]})

        llm.set_cache_key("agent", "research", "p1")
        with stub(handler):
            await llm.respond("ins", "q", search=False, max_tokens=50)
        self.assertEqual(seen["body"]["prompt_cache_key"], "agent:research:p1")


class AnnotationTest(unittest.IsolatedAsyncioTestCase):
    """The Responses API returns url_citation spans only some of the time; when it does we keep them, aligned to the text we return."""

    def setUp(self):
        self.patch = mock.patch.dict(os.environ, {"LLM_API_KEY": "k-test"}, clear=False)
        self.patch.start()
        for name in ("LLM_MODEL", "LLM_API_URL", "LLM_RESPONSES_URL", "MODEL_API_KEY"):
            os.environ.pop(name, None)

    def tearDown(self):
        self.patch.stop()

    async def respond_with(self, output):
        with stub(lambda req: httpx.Response(200, json={"status": "completed", "output": output})):
            return await llm.respond("i", "q", search=True)

    async def test_spans_are_returned_relative_to_the_stripped_answer_text(self):
        part1 = {"type": "output_text", "text": "  Plus costs 10 dollars. ", "annotations": [{"type": "url_citation", "url": "https://a.example/p", "title": "A", "start_index": 2, "end_index": 24}]}
        part2 = {"type": "output_text", "text": "Pro costs 20.", "annotations": [{"type": "url_citation", "url": "https://b.example/p", "title": "B", "start_index": 0, "end_index": 13}]}
        out = await self.respond_with([{"type": "message", "content": [{"type": "output_text", "text": "Let me search.", "annotations": []}]}, {"type": "web_search_call", "results": []},
                                       {"type": "message", "content": [part1, part2]}])
        self.assertEqual(out["text"], "Plus costs 10 dollars. Pro costs 20.")
        spans = {a["url"]: out["text"][a["start"]:a["end"]] for a in out["annotations"]}
        self.assertEqual(spans, {"https://a.example/p": "Plus costs 10 dollars.", "https://b.example/p": "Pro costs 20."})

    async def test_no_annotations_is_an_empty_list_and_malformed_spans_are_ignored(self):
        plain = await self.respond_with([{"type": "message", "content": [{"type": "output_text", "text": "Hello.", "annotations": []}]}])
        self.assertEqual(plain["annotations"], [])
        bad = [{"type": "url_citation", "url": "https://a.example", "start_index": "x", "end_index": 3}, {"type": "url_citation", "url": "https://a.example", "start_index": 4, "end_index": 99},
               {"type": "url_citation", "start_index": 0, "end_index": 2}, {"type": "file_citation", "url": "https://a.example", "start_index": 0, "end_index": 2}]
        out = await self.respond_with([{"type": "message", "content": [{"type": "output_text", "text": "Hello.", "annotations": bad}]}])
        self.assertEqual(out["annotations"], [])


if __name__ == "__main__":
    unittest.main()
