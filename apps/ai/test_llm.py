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


if __name__ == "__main__":
    unittest.main()
