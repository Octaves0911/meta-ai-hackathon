#!/usr/bin/env bash
# Prints fresh random values for the three secrets you must set on your host. Run it, copy each line into the host's secrets page, then close the terminal.
# Nothing is written to disk.
set -euo pipefail
echo "INTERNAL_SECRET=$(openssl rand -hex 24)"
echo "TOKEN_ENC_KEY=$(openssl rand -base64 32)"
echo "# (the database password comes from your database provider)"
