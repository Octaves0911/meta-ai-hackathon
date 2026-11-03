"""Quality gate (docs/09 §1.5): a cheap structured self-check after drafting, one repair attempt, and deterministic fact checks.
Produces the Confidence score and the "Needs your input" list shown at the top of a review."""
import re

from pydantic import BaseModel, Field

from llm import chat_json

CHECK_SCHEMA = {
    "type": "object",
    "properties": {
        "confidence": {"type": "number"},
        "blocking": {"type": "array", "items": {"type": "string"}},
        "open_questions": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["confidence", "blocking", "open_questions"],
    "additionalProperties": False,
}

RUBRIC = {
    "research": "Does it answer the task? Is every claim traceable to the project brief OR to the numbered web findings and verified sources given (a [n] marker is a valid citation; web figures need no other source)? Are unknowns listed instead of guessed? Flag only invented numbers, ignored decisions and unsupported claims.",
    "marketing": "Does it use the CURRENT decisions (dates, pricing) from the brief? Is every number sourced or labelled as an assumption? Are owners real people from the brief?",
    "designer": "Does the brief state goal, audience, palette, type and layout, with real copy? Does it respect the constraints stated in the meeting?",
    "communication": "Do all dates, numbers and names in the email appear in the brief (use the latest decision values)? No invented recipients? Is the tone right for the audience? Anything promised that was not decided?",
    "code": "Does the plan name concrete files/steps? Are risks and tests listed? Does it stay within what was asked?",
}


class Check(BaseModel):
    confidence: float = Field(ge=0, le=1)
    blocking: list[str] = Field(default_factory=list)
    open_questions: list[str] = Field(default_factory=list)

    @property
    def passed(self) -> bool:
        return not self.blocking


def _clamp(v) -> float:
    try:
        return min(max(float(v), 0.0), 1.0)
    except (TypeError, ValueError):
        return 0.5


async def self_check(agent: str, brief: str, deliverable: str, *, model: str | None = None) -> Check:
    """Structured critique. A check that itself fails must not take the run down: it degrades to 'unchecked' (confidence 0.5)."""
    try:
        data = await chat_json(
            "You are a strict reviewer of AI-written work. Judge the deliverable against the rubric and the brief. "
            "`blocking` lists concrete defects that must be fixed (wrong or unsupported facts, ignored decisions, placeholders, invented data); "
            "leave it empty if the work is acceptable. `open_questions` lists things a human must confirm or supply. "
            "`confidence` is 0..1 for how ready this is to hand to the user. Be terse.",
            f"Rubric: {RUBRIC.get(agent, 'Is it correct, complete and grounded in the brief?')}\n\nBrief:\n{brief[:9000]}\n\nDeliverable:\n{deliverable[:9000]}",
            CHECK_SCHEMA, max_tokens=600, model=model)
        return Check(confidence=_clamp(data.get("confidence")), blocking=[str(x)[:300] for x in data.get("blocking", [])][:6],
                     open_questions=[str(x)[:300] for x in data.get("open_questions", [])][:6])
    except Exception:  # noqa: BLE001 - provider/validation trouble => unchecked, not failed
        return Check(confidence=0.5, blocking=[], open_questions=["Automatic quality check was unavailable; please review carefully."])


_MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec"
_DATE = re.compile(rf"\b(\d{{4}}-\d{{2}}-\d{{2}}|(?:{_MONTHS})[a-z]*\.?\s+\d{{1,2}}(?:st|nd|rd|th)?|\d{{1,2}}(?:st|nd|rd|th)?\s+(?:{_MONTHS})[a-z]*)\b", re.I)
_MONEY = re.compile(r"(?:[$€£₹]\s?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s?[kKmM]\b)?|\b\d+(?:\.\d+)?\s?%)")


def _norm(s: str) -> str:
    return re.sub(r"[\s,]+", " ", s.lower().replace("sept", "sep")).strip()


def unsupported_facts(output: str, grounding: str) -> list[str]:
    """Dates, amounts and percentages that appear in `output` but nowhere in the grounding text. Deterministic, so it cannot be
    argued with: used by Communication (and any agent whose figures must come from the meeting)."""
    ground = _norm(grounding)
    bad: list[str] = []
    for rx in (_DATE, _MONEY):
        for m in rx.finditer(output):
            frag = _norm(m.group(0))
            if frag and frag not in ground and frag not in bad:
                bad.append(m.group(0).strip())
    return bad[:8]
