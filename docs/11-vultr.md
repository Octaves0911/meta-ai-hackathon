# 11 · Deploying MeetPilot on a Vultr server

One small server runs everything with Docker Compose: the app (web, backend, AI service, connector), Postgres with pgvector, and Caddy, which gets an HTTPS certificate automatically (browsers only allow the camera and microphone on HTTPS pages).

```
browser ──HTTPS──► Caddy :443 ──► app :7860 (backend + web + AI service + connector) ──► Postgres (same server)
                                                   └──► Meta Model API · Deepgram · Google · GitHub · Modal (optional)
```

## 1. Create the server
1. In Vultr: **Deploy → Cloud Compute**, **Ubuntu 24.04 LTS**, a region near your users, **at least 2 GB of RAM** (1 GB is too small for four processes and the build), and add your SSH key.
2. Note the server's public IP.
3. **Domain.** Create an `A` record for a hostname (for example `meet.example.com`) pointing at the IP. No domain? A free dynamic-DNS name (for example from duckdns.org) pointing at the IP works too. Wait until it resolves: `ping meet.example.com`.

## 2. Prepare the server
SSH in (`ssh root@<ip>`), then:

```bash
# Docker
curl -fsSL https://get.docker.com | sh

# A little swap so the first build does not run out of memory
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# Firewall: SSH, HTTP, HTTPS (and the video relay ports if you use TURN)
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp
ufw allow 3478/udp && ufw allow 49160:49200/udp      # only if you start the TURN relay
ufw --force enable
```
If you also use Vultr's own firewall group, open the same ports there.

## 3. Get the code onto the server
Either clone it (use a deploy key or a token if the repository is private):

```bash
git clone https://github.com/Octaves0911/meta-ai-hackathon.git /opt/meetpilot && cd /opt/meetpilot
```
or copy it from your laptop: `rsync -az --exclude node_modules --exclude .git --exclude .env ./ root@<ip>:/opt/meetpilot/`.

Use the branch that contains `infra/deploy/docker-compose.prod.yml` (`git checkout feat/deploy-live`, or `master` once it is merged).

## 4. Configure
```bash
cd /opt/meetpilot
cp infra/deploy/vultr.env.example .env.prod
infra/deploy/gen-secrets.sh        # prints INTERNAL_SECRET and TOKEN_ENC_KEY: paste them into .env.prod
nano .env.prod                     # DOMAIN, WEB_URL, POSTGRES_PASSWORD, LLM_API_KEY, DEEPGRAM_API_KEY, ...
chmod 600 .env.prod
```
What each setting does is in `infra/deploy/env.production.example`. Keep `AGENT_DAILY_CAP_USD` low: anyone with the URL can sign in and start agents.

## 5. Start it
```bash
docker compose -f infra/deploy/docker-compose.prod.yml --env-file .env.prod up -d --build
docker compose -f infra/deploy/docker-compose.prod.yml logs -f app     # wait for "listening"; Ctrl-C to leave the logs
```
The first build takes several minutes. Caddy requests the certificate on the first visit to your domain (ports 80 and 443 must be reachable).

With the TURN relay (video across strict networks), set `TURN_USERNAME` and `TURN_CREDENTIAL` in `.env.prod` and add the profile:
```bash
docker compose -f infra/deploy/docker-compose.prod.yml --env-file .env.prod --profile turn up -d
```

## 6. Check it
```bash
node infra/deploy/smoke.mjs https://meet.example.com --agents      # from any machine with Node 20+
```
Then open `https://meet.example.com`, sign in with a username and open a meeting. Set `SEED_DEMO=0` in `.env.prod` and run the `up -d` command again once the demo project exists.

## Day-to-day
```bash
# update to a new version
cd /opt/meetpilot && git pull && docker compose -f infra/deploy/docker-compose.prod.yml --env-file .env.prod up -d --build

# logs and status
docker compose -f infra/deploy/docker-compose.prod.yml ps
docker compose -f infra/deploy/docker-compose.prod.yml logs --tail=100 app

# back up the database
docker compose -f infra/deploy/docker-compose.prod.yml exec -T postgres pg_dump -U meetpilot meetpilot | gzip > meetpilot-$(date +%F).sql.gz
```

## Optional integrations
- **Google (Gmail / Drive):** create an OAuth client (Web), add `https://<domain>/api/connections/google/callback` as an authorised redirect URI, enable the Gmail and Drive APIs, and add your Google accounts as test users while the app is in Testing. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`.
- **Modal sandbox:** `SANDBOX_MODE=modal`, `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`. Check it once with `cd apps/ai && .venv/bin/python scripts/sandbox_live_check.py` from a machine that has the repository set up.
- **GitHub pull requests:** each project owner pastes a fine-grained token in the app.

## Known limits
- Login is username-only (a demo mechanism). Use made-up data and share the link only with people who should use your Meta key.
- Designer PDFs use the built-in design-board fallback because the container has no Chrome. HTML previews are unaffected.
- This is one server: if it is down the app is down. Back up the database before big changes.
