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


import json as _json

PNG = "data:image/png;base64,iVBORw0KGgo="


class VisionTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.patch = mock.patch.dict(os.environ, {"LLM_API_KEY": "k-test"}, clear=False)
        self.patch.start()
        for n in ("LLM_MODEL", "LLM_API_URL", "MODEL_API_KEY"):
            os.environ.pop(n, None)

    def tearDown(self):
        self.patch.stop()

    def test_only_small_real_image_data_urls_are_sent_and_at_most_four(self):
        self.assertEqual(llm.user_content("hi", None), "hi")
        self.assertEqual(llm.user_content("hi", ["https://evil.example/a.png", "data:text/html;base64,AAAA", "javascript:alert(1)", "x" * 10]), "hi")
        parts = llm.user_content("look", [PNG] * 6)
        self.assertEqual(parts[0], {"type": "text", "text": "look"})
        self.assertEqual(len(parts), 1 + llm.MAX_IMAGES)
        self.assertEqual(parts[1], {"type": "image_url", "image_url": {"url": PNG}})
        self.assertEqual(llm.user_content("big", ["data:image/png;base64," + "A" * 4_000_000]), "big")

    async def test_images_reach_the_model_as_content_parts(self):
        seen = {}

        def handler(req):
            seen["body"] = _json.loads(req.content)
            return ok('{"a": 1}')

        with stub(handler):
            await llm.chat_json("s", "what is wrong?", {"type": "object"}, images=[PNG])
        content = seen["body"]["messages"][1]["content"]
        self.assertEqual([p["type"] for p in content], ["text", "image_url"])


def sse(*chunks, usage=None):
    lines = [f"data: {_json.dumps({'choices': [{'delta': {'content': c}}]})}" for c in chunks]
    lines.append(f"data: {_json.dumps({'choices': [{'delta': {'content': None}, 'finish_reason': 'stop'}], 'usage': usage})}" if usage else 'data: {"choices": []}')
    lines.append("data: [DONE]")
    return httpx.Response(200, content=("\n\n".join(lines) + "\n\n").encode(), headers={"content-type": "text/event-stream"})


class StreamingTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.patch = mock.patch.dict(os.environ, {"LLM_API_KEY": "k-test"}, clear=False)
        self.patch.start()
        for n in ("LLM_MODEL", "LLM_API_URL", "MODEL_API_KEY"):
            os.environ.pop(n, None)

    def tearDown(self):
        self.patch.stop()

    def test_the_field_streamer_decodes_escapes_across_any_chunk_boundary(self):
        doc = '{"kind":"ask","reply":"Say \\"hi\\"\\nthen \\u00e9\\u4e2d done","proposed_change":""}'
        for size in (1, 2, 3, 5, 7, 100):
            f = llm.FieldStreamer("reply")
            got = "".join(f.feed(doc[i:i + size]) for i in range(0, len(doc), size))
            self.assertEqual(got, 'Say "hi"\nthen é中 done', size)
            self.assertTrue(f.done)
        f = llm.FieldStreamer("reply")
        self.assertEqual(f.feed('{"kind":"ask","proposed_change":"x"}'), "")     # no such field: nothing is emitted

    async def test_deltas_arrive_before_the_answer_is_complete_and_usage_is_counted(self):
        usage = llm.begin_usage()
        seen = {}

        def handler(req):
            seen["body"] = _json.loads(req.content)
            return sse('{"kind":"ask","re', 'ply":"Hel', 'lo wor', 'ld","proposed_change":""}', usage={"prompt_tokens": 100, "completion_tokens": 20, "prompt_tokens_details": {"cached_tokens": 64}})

        events = []
        with stub(handler):
            async for ev in llm.stream_chat_json("s", "u", {"type": "object"}, "reply"):
                events.append(ev)
        self.assertTrue(seen["body"]["stream"])
        self.assertEqual(seen["body"]["stream_options"], {"include_usage": True})
        deltas = [v for k, v in events if k == "delta"]
        self.assertGreaterEqual(len(deltas), 2)                       # more than one piece, so the UI really streams
        self.assertEqual("".join(deltas), "Hello world")
        self.assertEqual(events[-1], ("done", {"kind": "ask", "reply": "Hello world", "proposed_change": ""}))
        self.assertEqual((usage["prompt_tokens"], usage["completion_tokens"], usage["cached_tokens"]), (100, 20, 64))

    async def test_provider_errors_and_broken_json_become_502s(self):
        with stub(lambda req: httpx.Response(500, text="no")):
            with self.assertRaises(HTTPException) as c:
                async for _ in llm.stream_chat_json("s", "u", {}, "reply"):
                    pass
        self.assertEqual(c.exception.status_code, 502)
        with stub(lambda req: sse("not json at all")):
            with self.assertRaises(HTTPException) as c:
                async for _ in llm.stream_chat_json("s", "u", {}, "reply"):
                    pass
        self.assertEqual(c.exception.status_code, 502)


class ToolCallingTest(unittest.IsolatedAsyncioTestCase):
    TOOLS = [{"type": "function", "function": {"name": "list_tasks", "description": "d", "parameters": {"type": "object", "properties": {}}}}]

    def setUp(self):
        self.patch = mock.patch.dict(os.environ, {"LLM_API_KEY": "k-test"}, clear=False)
        self.patch.start()
        for n in ("LLM_MODEL", "LLM_API_URL", "MODEL_API_KEY"):
            os.environ.pop(n, None)
        self.sleep = mock.patch.object(llm.asyncio, "sleep", mock.AsyncMock())
        self.sleep.start()

    def tearDown(self):
        self.sleep.stop()
        self.patch.stop()

    @staticmethod
    def wants(name, args, cid="call_1"):
        return httpx.Response(200, json={"choices": [{"finish_reason": "tool_calls", "message": {"role": "assistant", "content": None, "tool_calls": [{"id": cid, "type": "function", "function": {"name": name, "arguments": args}}]}}]})

    async def test_the_tool_result_goes_back_with_the_assistant_turn_and_the_model_answers(self):
        bodies, ran = [], []

        def handler(req):
            bodies.append(_json.loads(req.content))
            return self.wants("list_tasks", "{}") if len(bodies) == 1 else ok("Sam owns it.")

        async def run_tool(name, args):
            ran.append((name, args))
            return [{"title": "Research pricing", "owner": "sam"}]

        with stub(handler):
            text, trace = await llm.chat_with_tools("s", "who owns research?", self.TOOLS, run_tool)
        self.assertEqual(text, "Sam owns it.")
        self.assertEqual(ran, [("list_tasks", {})])
        self.assertEqual(trace, [{"name": "list_tasks", "args": {}, "ok": True}])
        roles = [m["role"] for m in bodies[1]["messages"]]
        self.assertEqual(roles, ["system", "user", "assistant", "tool"])             # the assistant tool_calls turn is replayed before the result
        self.assertEqual(bodies[1]["messages"][3]["tool_call_id"], "call_1")
        self.assertIn("Research pricing", bodies[1]["messages"][3]["content"])
        self.assertIn("tools", bodies[0])

    async def test_unknown_tools_bad_arguments_and_failing_tools_are_reported_not_run(self):
        calls = iter([self.wants("drop_database", "{}"), self.wants("list_tasks", "not json", "c2"), self.wants("list_tasks", "{}", "c3"), ok("done")])
        ran = []

        async def run_tool(name, args):
            ran.append(name)
            raise RuntimeError("backend down")

        with stub(lambda req: next(calls)):
            text, trace = await llm.chat_with_tools("s", "q", self.TOOLS, run_tool)
        self.assertEqual(text, "done")
        self.assertEqual(ran, ["list_tasks"])                                          # the unknown tool and the bad JSON never executed
        self.assertEqual([t["ok"] for t in trace], [False, False, False])

    async def test_a_model_that_never_stops_asking_is_cut_off(self):
        seen = []

        def handler(req):
            b = _json.loads(req.content)
            seen.append("tools" in b)
            return self.wants("list_tasks", "{}") if "tools" in b else ok("final")

        async def run_tool(name, args):
            return []

        with stub(handler):
            text, _ = await llm.chat_with_tools("s", "q", self.TOOLS, run_tool, max_rounds=2)
        self.assertEqual(text, "final")
        self.assertEqual(seen, [True, True, False])                                    # the last round has no tools, so it must answer


if __name__ == "__main__":
    unittest.main()
