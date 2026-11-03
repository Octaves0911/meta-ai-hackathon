"""Read-only repository access for the Code agent, through the connector (which holds the sealed GitHub token and refuses secret paths).
The token never reaches this process except for the sandbox's clone (clone_token), and never reaches a model."""
import os

import httpx


class GithubReadError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message


def _base() -> str:
    return os.environ.get("CONNECTOR_URL", "http://localhost:6100").rstrip("/")


async def _get(path: str, params: dict) -> dict:
    try:
        async with httpx.AsyncClient(timeout=30) as c:
            res = await c.get(f"{_base()}{path}", params=params, headers={"x-internal-secret": os.environ.get("INTERNAL_SECRET", "")})
    except httpx.HTTPError as e:
        raise GithubReadError("connector_unavailable", "the integrations service is not reachable") from e
    if res.status_code >= 400:
        try:
            err = res.json().get("error", {})
        except ValueError:
            err = {}
        raise GithubReadError(err.get("code", "github_error"), err.get("message", f"GitHub access failed ({res.status_code})"))
    return res.json()


async def tree(project_id: str, owner: str, name: str, ref: str) -> dict:
    """{'ref', 'truncated', 'files': [{'path', 'size'}]}"""
    return await _get("/github/tree", {"projectId": project_id, "owner": owner, "name": name, "ref": ref})


async def file(project_id: str, owner: str, name: str, path: str, ref: str) -> dict:
    """{'path', 'size', 'text'}"""
    return await _get("/github/file", {"projectId": project_id, "owner": owner, "name": name, "ref": ref, "path": path})


async def clone_token(project_id: str) -> str | None:
    return (await _get("/github/clone-token", {"projectId": project_id})).get("token")
