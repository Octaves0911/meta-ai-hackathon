#!/usr/bin/env bash
# Publishes the current commit to a Hugging Face Space (Docker SDK). The Space gets its own README with the required front matter;
# your GitHub README is untouched.
#   usage: infra/deploy/push-to-hf.sh <hf-username>/<space-name>
# Needs a Hugging Face access token with write access (it will ask for it when git prompts for a password).
set -euo pipefail
SPACE="${1:?usage: push-to-hf.sh <hf-username>/<space-name>}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
git diff --quiet && git diff --cached --quiet || { echo "commit your changes first"; exit 1; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
git archive HEAD | tar -x -C "$TMP"
cp infra/deploy/hf-space-README.md "$TMP/README.md"
cd "$TMP"
git init -q -b main
git add -A
git -c user.name="deploy" -c user.email="deploy@localhost" commit -q -m "Deploy MeetPilot"
git push --force "https://huggingface.co/spaces/${SPACE}" main
echo "pushed. Watch the build at https://huggingface.co/spaces/${SPACE}"
