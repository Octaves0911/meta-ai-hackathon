import os
import sys

from fastapi import FastAPI

# Fail closed: refuse to run without the shared secret (docs/06).
if not os.environ.get("INTERNAL_SECRET"):
    sys.exit("INTERNAL_SECRET is not set; refusing to start")

app = FastAPI(title="MeetPilot AI service")


@app.get("/health")
def health() -> dict:
    return {"service": "ai", "status": "ok"}
