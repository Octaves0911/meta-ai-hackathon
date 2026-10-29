import os
import sys

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

# Fail closed: refuse to run without the shared secret (docs/06).
INTERNAL_SECRET = os.environ.get("INTERNAL_SECRET")
if not INTERNAL_SECRET:
    sys.exit("INTERNAL_SECRET is not set; refusing to start")

EMBEDDING_DIM = 1536

app = FastAPI(title="MeetPilot AI service")


def require_secret(x_internal_secret: str | None = Header(default=None)) -> None:
    if x_internal_secret != INTERNAL_SECRET:
        raise HTTPException(status_code=401, detail="invalid internal secret")


@app.get("/health")
def health() -> dict:
    return {"service": "ai", "status": "ok"}


class EmbedRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=64)


class EmbedResponse(BaseModel):
    vectors: list[list[float]]


@app.post("/embed", response_model=EmbedResponse, dependencies=[Depends(require_secret)])
async def embed(req: EmbedRequest) -> EmbedResponse:
    """Embeddings via any OpenAI-compatible endpoint (EMBEDDING_API_URL / _KEY / _MODEL), always 1536-dim."""
    key = os.environ.get("EMBEDDING_API_KEY")
    if not key:
        raise HTTPException(status_code=503, detail="EMBEDDING_API_KEY is not configured")
    url = os.environ.get("EMBEDDING_API_URL", "https://api.openai.com/v1/embeddings")
    payload = {
        "model": os.environ.get("EMBEDDING_MODEL", "text-embedding-3-small"),
        "input": [t[:8000] for t in req.texts],
        "dimensions": EMBEDDING_DIM,
    }
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            res = await client.post(url, json=payload, headers={"Authorization": f"Bearer {key}"})
            res.raise_for_status()
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"embedding provider failed: {type(e).__name__}") from e
    data = sorted(res.json()["data"], key=lambda d: d["index"])
    vectors = [d["embedding"] for d in data]
    if len(vectors) != len(req.texts) or any(len(v) != EMBEDDING_DIM for v in vectors):
        raise HTTPException(status_code=502, detail="embedding provider returned unexpected shape")
    return EmbedResponse(vectors=vectors)
