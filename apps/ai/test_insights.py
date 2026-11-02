"""Schema tolerance for model output. Run: cd apps/ai && .venv/bin/python -m unittest -v"""
import unittest

from insights import Event


class EventSchemaTest(unittest.TestCase):
    def test_null_details_and_quote_are_accepted(self):
        e = Event(type="decision", summary="Launch on Nov 25", details=None, quote=None, priority=None, from_seq=1, to_seq=1)
        self.assertEqual((e.details, e.quote), ("", ""))

    def test_unknown_priority_becomes_none(self):
        self.assertIsNone(Event(type="task", summary="x", priority="urgent", from_seq=1, to_seq=1).priority)
        self.assertEqual(Event(type="task", summary="x", priority="HIGH", from_seq=1, to_seq=1).priority, "high")


if __name__ == "__main__":
    unittest.main()
