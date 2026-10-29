"""Extractor, judge and answerer endpoints (docs/04). Output is schema-validated before the backend acts on it."""
import json
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, ValidationError

from llm import complete_json, sanitize_label

EventType = Literal["task", "decision", "deadline", "question", "blocker", "info"]
Kind = Literal["conflict", "answer", "reminder", "context", "no_record", "external"]


class Line(BaseModel):
    seq: int
    speaker: str
    text: str


class Event(BaseModel):
    type: EventType
    entity_key: str | None = None
    value: str | None = None
    summary: str
    who: str | None = None
    due_text: str | None = None
    references_earlier: bool = False
    quote: str = ""
    from_seq: int
    to_seq: int


class ExtractRequest(BaseModel):
    lines: list[Line] = Field(min_length=1, max_length=40)
    earlier: list[Line] = Field(default_factory=list, max_length=10)
    today: str


class ExtractResponse(BaseModel):
    events: list[Event]


class Candidate(BaseModel):
    id: str
    label: str
    text: str
    score: float
    source_type: str
    entity_key: str | None = None
    value: str | None = None


class JudgeRequest(BaseModel):
    event: Event
    candidates: list[Candidate] = Field(max_length=6)


class JudgeResponse(BaseModel):
    speak: bool
    kind: Kind = "context"
    score: float = Field(default=0, ge=0, le=1)
    title: str = ""
    message: str = ""
    source_id: str | None = None
    topic_key: str = ""


class AnswerRequest(BaseModel):
    question: str = Field(max_length=1000)
    context: list[Candidate] = Field(max_length=12)


class AnswerResponse(BaseModel):
    answer: str
    used_ids: list[str]


def build_router(require_secret) -> APIRouter:
    r = APIRouter(dependencies=[Depends(require_secret)])

    @r.post("/extract", response_model=ExtractResponse)
    async def extract(req: ExtractRequest) -> ExtractResponse:
        system = (
            "You extract structured facts from live meeting transcript lines. Emit one event per task created, decision made, "
            "deadline set, question raised, blocker or important information shared. Ignore small talk. "
            "For decisions about a recurring fact use a snake_case entity_key (e.g. deployment_date) and put the new value in `value`. "
            "Set references_earlier=true when the speaker refers to an earlier meeting (\"as we discussed\"). "
            "For a task put the person responsible in `who` (the speaker if they volunteer) and a short imperative title in `summary` (e.g. \"Send the pricing report\"), with any spoken deadline in `due_text`. Keep summaries under 160 characters and quotes under 240. "
            'Return {"events":[{"type","entity_key","value","summary","who","due_text","references_earlier","quote","from_seq","to_seq"}]}. '
            f"Today is {req.today}."
        )
        user = "Earlier context:\n<transcript>\n" + "\n".join(f"{l.speaker}: {l.text}" for l in req.earlier) + "\n</transcript>\n" \
            "New lines to analyse:\n<transcript>\n" + "\n".join(f"[{l.seq}] {l.speaker}: {l.text}" for l in req.lines) + "\n</transcript>"
        data = await complete_json(system, user)
        try:
            return ExtractResponse(events=[Event(**e) for e in data.get("events", [])])
        except (ValidationError, TypeError) as e:
            raise HTTPException(status_code=502, detail=f"extractor output invalid: {e}") from e

    @r.post("/judge", response_model=JudgeResponse)
    async def judge(req: JudgeRequest) -> JudgeResponse:
        system = (
            "You decide whether an AI meeting assistant should interrupt. Question to answer: 'would showing this change what people "
            "say or decide right now?' Refuse vague topical overlap and restatements of what was just said. Use kind=conflict only when the "
            "event contradicts a stored decision with the same entity_key; kind=no_record only when someone claims an earlier agreement "
            "and no candidate supports it. The message is at most 2 sentences and must name its source. score is 0..1. "
            'Return {"speak","kind","score","title","message","source_id","topic_key"}; source_id is the id of the candidate used.'
        )
        def tag(c: Candidate) -> str:
            attrs = f'id="{c.id}" label="{sanitize_label(c.label)}" type="{c.source_type}" similarity="{c.score:.2f}"'
            if c.entity_key:
                attrs += f' entity_key="{sanitize_label(c.entity_key)}" value="{sanitize_label(c.value or "")}"'
            body = c.text.replace("<", " ").replace(">", " ")
            return f"<untrusted_source {attrs}>{body}</untrusted_source>"

        cands = "\n".join(tag(c) for c in req.candidates)
        user = f"Event:\n{json.dumps(req.event.model_dump())}\n\nCandidates:\n{cands or '(none)'}"
        data = await complete_json(system, user, max_tokens=600)
        try:
            out = JudgeResponse(**data)
        except (ValidationError, TypeError) as e:
            raise HTTPException(status_code=502, detail=f"judge output invalid: {e}") from e
        valid = {c.id for c in req.candidates}
        if out.source_id and out.source_id not in valid:
            out.source_id = None
        out.message = out.message[:400]
        return out

    @r.post("/answer", response_model=AnswerResponse)
    async def answer(req: AnswerRequest) -> AnswerResponse:
        system = (
            "Answer the question using ONLY the provided sources. Be concise (at most 3 sentences) and name the source labels you used. "
            "If the sources do not contain the answer, say so. "
            'Return {"answer": string, "used_ids": [source ids]}.'
        )
        srcs = "\n".join(
            f'<untrusted_source id="{c.id}" label="{sanitize_label(c.label)}">{c.text.replace("<", " ").replace(">", " ")}</untrusted_source>'
            for c in req.context
        )
        data = await complete_json(system, f"Question: {req.question}\n\nSources:\n{srcs or '(none)'}", max_tokens=700)
        try:
            out = AnswerResponse(answer=str(data["answer"])[:1200], used_ids=[str(i) for i in data.get("used_ids", [])])
        except (KeyError, ValidationError) as e:
            raise HTTPException(status_code=502, detail=f"answer output invalid: {e}") from e
        out.used_ids = [i for i in out.used_ids if i in {c.id for c in req.context}]
        return out

    return r
