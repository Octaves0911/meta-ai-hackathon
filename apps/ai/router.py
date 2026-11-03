"""Router v2 (docs/09 §1.3, §1.9): decide which specialist (if any) should do a task, how sure we are, and whether the work is a
multi-stage hand-off (web-page design → code). The backend keeps the regex rules as a veto for obvious human work and as the
fallback when this endpoint or the model is unavailable."""
import os
import re
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from brief import BriefIn, render_brief
from llm import chat_json

AGENTS = ("research", "marketing", "designer", "communication", "code")
CATEGORIES = ("code", "marketing", "design", "communication", "research", "general")

# Hand-off to Code happens ONLY for web-page design (docs/09 §1.9).
WEB = re.compile(r"\b(landing page|website|web ?site|web ?page|home ?page|web app|webapp|site|dashboard ui|sign-?up page|pricing page|checkout page|build the page|implement the page)\b", re.I)
NON_WEB = re.compile(r"\b(card|banner|poster|logo|template|flyer|brochure|social|post|slide|deck|presentation|icon|illustration|business card|invitation|sticker|merch|packaging|brand(?:ing)?|infographic)\b", re.I)
ONLY_DESIGN = re.compile(r"\b(only the (?:design|mock-?up)|just the (?:design|mock-?up)|mock-?up only|design only|wireframe only|no (?:code|implementation))\b", re.I)

ROUTE_SCHEMA = {
    "type": "object",
    "properties": {
        "category": {"type": "string", "enum": list(CATEGORIES)},
        "agent": {"type": "string", "enum": [*AGENTS, "none"]},
        "can_ai_do": {"type": "boolean"},
        "confidence": {"type": "number"},
        "reason": {"type": "string"},
        "human_reason": {"type": "string"},
        "missing_inputs": {"type": "array", "items": {"type": "string"}},
        "web_page": {"type": "boolean"},
    },
    "required": ["category", "agent", "can_ai_do", "confidence", "reason", "human_reason", "missing_inputs", "web_page"],
    "additionalProperties": False,
}

SYSTEM = (
    "You route tasks from a meeting to one AI specialist or to a human.\n"
    "Agents: research (find out, compare, analyse, summarise, benchmark), marketing (campaigns, positioning, launch/GTM plans, press releases, social copy), "
    "designer (visual design: pages, banners, business cards, posters, logos, templates, mockups, wireframes), communication (emails, replies, announcements, follow-ups), "
    "code (implement, fix, refactor, tests in a code repository).\n"
    "Use agent=\"none\" (can_ai_do=false) for work that needs a person: phone calls, meetings, payments, hiring, legal sign-off, physical or in-person work, "
    "decisions that belong to people. Explain in `human_reason`.\n"
    "`confidence` is 0..1 for how sure you are WHICH AGENT fits, not how detailed the task is. A task that clearly names one agent's kind of work "
    "(e.g. 'design a business card', 'draft the announcement email', 'compare competitors') is 0.85+ even if details are missing. "
    "Use below 0.6 ONLY when the task is vague ('look into that', 'handle the thing') or could equally fit several agents; list what is missing in `missing_inputs`. "
    "`web_page` is true only when a web page/site/web app screen is being designed or built. "
    "Judge the TASK TITLE first; the spoken sentence and transcript are context."
)


class Stage(BaseModel):
    agent: str
    goal: str


class RouteOut(BaseModel):
    category: str
    agent: str | None
    stages: list[Stage]
    scope: Literal["deliverable", "build"] = "deliverable"
    can_ai_do: bool
    confidence: float = Field(ge=0, le=1)
    reason: str = ""
    human_reason: str = ""
    missing_inputs: list[str] = Field(default_factory=list)
    web_page: bool = False   # a web page/site is being designed or built: its approved design may be built by the Code agent


def plan_stages(agent: str | None, title: str, goal_text: str, web_page: bool) -> tuple[list[Stage], str]:
    """Stages for one task. Designer → Code only when a web page is being designed and the wording does not ask for design only."""
    if not agent:
        return [], "deliverable"
    stages = [Stage(agent=agent, goal=title[:200])]
    if agent == "designer" and web_page and WEB.search(f"{title} {goal_text}") and not NON_WEB.search(title) and not ONLY_DESIGN.search(f"{title} {goal_text}"):
        stages.append(Stage(agent="code", goal=f"Implement the approved design: {title}"[:200]))
        return stages, "build"
    return stages, "deliverable"


def normalise(data: dict, title: str, goal_text: str) -> RouteOut:
    agent = data.get("agent")
    agent = agent if agent in AGENTS else None
    category = data.get("category") if data.get("category") in CATEGORIES else "general"
    try:
        conf = min(max(float(data.get("confidence", 0.5)), 0.0), 1.0)
    except (TypeError, ValueError):
        conf = 0.5
    stages, scope = plan_stages(agent, title, goal_text, bool(data.get("web_page")))
    return RouteOut(category=category, agent=agent, stages=stages, scope=scope, can_ai_do=bool(data.get("can_ai_do")) and agent is not None, confidence=conf,
                    reason=str(data.get("reason", ""))[:300], human_reason=str(data.get("human_reason", ""))[:300],
                    missing_inputs=[str(x)[:200] for x in data.get("missing_inputs", [])][:5],
                    web_page=agent == "designer" and bool(data.get("web_page")) and bool(WEB.search(f"{title} {goal_text}")) and not NON_WEB.search(title))


def build_router(require_secret) -> APIRouter:
    r = APIRouter(dependencies=[Depends(require_secret)])

    @r.post("/route", response_model=RouteOut)
    async def route(req: BriefIn) -> RouteOut:
        if os.environ.get("AGENTS_MODE") == "mock":
            raise HTTPException(status_code=503, detail="router model disabled in mock mode")  # backend falls back to its rules
        data = await chat_json(SYSTEM, render_brief(req), ROUTE_SCHEMA, max_tokens=500, model=os.environ.get("ROUTER_MODEL") or None)
        return normalise(data, req.task.title, f"{req.task.description or ''} {req.quote or ''}")

    return r
