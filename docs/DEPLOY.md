# Deploying Hakusan Monitor long-term

Two supported ways to keep it running. **The hard part for both is the same:
non-interactive SSH to the login node** (see *SSH auth* below) — not the runtime.

## Recommendation

For this single host (`cpu-723717`), **systemd user service** is the simpler
choice:

| | systemd user service | Docker / Compose |
|---|---|---|
| Install / deps | none (stdlib Python) | build image, needs ssh-client in image |
| Update on code change | `systemctl --user restart` | `docker compose up -d --build` (rebuild) |
| SSH to login node | uses host agent directly | must **forward the agent socket** into the container |
| Survives reboot | yes (`enable-linger`, already on) | yes (`restart: unless-stopped`) — if agent is back |
| Logs | `journalctl --user -u hakusan-monitor` | `docker logs hakusan-monitor` |

The app has **zero Python dependencies**, so Docker's main benefit (bundling
deps / isolation) buys little here, while it *adds* the SSH-agent-into-container
step. Use Docker if you specifically want everything managed the same way as your
other containers; otherwise prefer systemd.

## Option A — systemd user service (recommended)

```bash
loginctl enable-linger "$USER"            # already enabled on this box
mkdir -p ~/.config/systemd/user
cp deploy/hakusan-monitor.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now hakusan-monitor
systemctl --user status hakusan-monitor
journalctl --user -u hakusan-monitor -f   # logs
```

Open `http://localhost:8787` (or the box's IP / Tailscale address).

### Updating an existing systemd deployment

Build the static frontend first, then restart the backend so the API and the
browser bundle switch versions together:

```bash
cd ~/temp/hakusan-monitor
(cd web && npm ci && npm run build)
systemctl --user restart hakusan-monitor
curl -fsS http://127.0.0.1:8787/api/health
```

Do not treat a successful frontend build as a completed deployment: the
long-running Python process must also be restarted. The frontend accepts the
immediately preceding unversioned snapshot during this short hand-off, but a
restart is still required to activate backend fixes.

## Option B — Docker Compose

```bash
source ~/.ssh/.agent_env                  # so the agent socket can be forwarded
SSH_AUTH_SOCK="$SSH_AUTH_SOCK" docker compose up -d --build
docker logs -f hakusan-monitor
```

`data/` (the SQLite history) is bind-mounted so it survives container rebuilds.
The Docker base images are digest-pinned; Dependabot proposes reviewed digest
and frontend dependency updates weekly.

## SSH auth — the thing that actually matters for "always on"

The collector logs in to your SSH target (`HM_SSH_HOST`, set in `.env` — e.g.
`you@hakusan2`). If `HM_LOGIN_NODES` is set, the login-node health sampler uses
the same SSH options/agent for each configured target, e.g.
`hakusan1=you@hakusan1,hakusan2=you@hakusan2`. Today that uses your **interactive
ssh-agent** (`~/.ssh/.agent_env`) holding the passphrase-protected key. That works
while the agent (and the box) stays up — but **after a reboot the agent is gone**,
so the service can't SSH until you re-run `ssh-add` and refresh `~/.ssh/.agent_env`.

For **fully unattended** operation across reboots, use a dedicated key:

```bash
ssh-keygen -t ed25519 -N '' -f ~/.ssh/hakusan_monitor      # passphrase-less
ssh-copy-id -i ~/.ssh/hakusan_monitor.pub "$HM_SSH_HOST"   # e.g. you@hakusan2
# then point the service at it:
#   HM_SSH_OPTS="-i ~/.ssh/hakusan_monitor -o BatchMode=yes -o ControlMaster=auto -o ControlPath=~/.ssh/hm-%r@%h:%p -o ControlPersist=120"
```

Trade-off: a private key without a passphrase lives on disk — but it only grants
this box read-only `squeue`/`scontrol` access to the cluster. Standard for a
service account. (Ask and I'll wire this up.)

## Notes

- The service is read-only and login-node-friendly: one compact query every
  `HM_SAMPLE_INTERVAL` seconds (default 300 = 5 min) over a reused SSH connection.
- Login-node health sampling is also read-only and TTL-paced by
  `HM_LOGIN_INTERVAL` (default 300 s), collecting `/proc`, byte/inode `df`, and compact `ps`
  summaries for the Login nodes page.
- Set `TZ=Asia/Tokyo` (both unit and compose already do) so *Usage patterns*
  hour-of-day is in cluster time.
- Change the port with `HM_PORT`; usernames are shown by default. Set
  `HM_MASK_USERS=1` to anonymize them.
- Cluster, login-node, and anonymous visit retention are independently
  configurable with `HM_RETAIN_DAYS`, `HM_LOGIN_RETAIN_DAYS`, and
  `HM_VISIT_RETAIN_DAYS`.
- Leave `HM_TRUST_PROXY=0` unless a trusted reverse proxy overwrites
  `X-Forwarded-For`; set `HM_ACCESS_LOG=1` only when request logging is useful.
- For public or off-campus access, put it behind a reverse proxy with TLS and
  access control, and enable `HM_MASK_USERS=1` at minimum.
