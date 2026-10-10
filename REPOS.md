# REPOS — how the HelixMain platform is split, pinned and synced

Five repos make up the platform. They are separate on purpose: the card format
is a contract other people's agents read, so it must be versioned independently
of the product that happens to emit it.

| Repo | Role | Canonical remote |
|---|---|---|
| `helixmain` | the business: card compiler, API, dashboard, Hugo site, MCP server, infra | `cryptonomicsed-byte/helixmain` |
| `card-protocol` | the card **spec of record** (`business-card/0.1` + upstream `0.2`) | `cryptonomicsed-byte/card-protocol` |
| `agent-voice` | the AI front desk: Nostr-signalled WebRTC voice endpoint | `cryptonomicsed-byte/agent-voice` |
| `minipae` | NIP-AE engram substrate (memory). `mem/card/<id>/*` lives here | `cryptonomicsed-byte/minipae` |
| `agent-phone` | Nostr signalling primitives + identity | `cryptonomicsed-byte/agent-phone` |

`Bino-Elgua` and `omokoda` remotes are retired — never push to them.

## What is pinned, and where

- **card-protocol** is a git submodule of `helixmain` at `vendor/card-protocol`,
  pinned to a commit. It is the source of truth for the card format; helixmain's
  `agent-os/contracts/business-card-spec.md` is a stale historical copy and
  `agent-os/contracts/card-format-compatibility.md` supersedes it as the
  decision record.
- **agent-phone** and **minipae** are pinned by commit in
  `agent-voice/requirements.txt`. Never `@main`.

Current pins:

```
card-protocol    c9f2b0349657514381139cbcbbac65387d3181a6   (helixmain/vendor/card-protocol)
agent-phone      39d91960ba70c0be2da9bab6c271530d896a9507   (agent-voice/requirements.txt)
minipae          99eb98bf9fa4e679067f512d1e2595557cfc574a   (agent-voice/requirements.txt)
```

Verify a pin resolves before trusting it:

```bash
python -m pip install --dry-run --no-deps \
  "minipae @ git+https://github.com/cryptonomicsed-byte/minipae.git@99eb98bf9fa4e679067f512d1e2595557cfc574a"
```

## The two install modes — do not confuse them

**1. Fresh install (a new machine).** `pip install -r requirements.txt`
resolves the pinned git refs. Nothing to sync.

**2. The live host (this VPS).** The repos are *sibling checkouts* under `/opt`,
not pip-installed copies:

```
/opt/agent-voice    -> venv editable install (site-packages/__editable__.agent_voice-0.1.0.pth)
/opt/agent-phone    -> site-packages/agent_voice_deps.pth
/opt/minipae        -> site-packages/agent_voice_deps.pth
/opt/helixmain      -> the helixmain checkout
```

So on the host, "installing" is **`git pull` + restart**. `pip install -r
requirements.txt` there would do nothing useful and risks shadowing the
checkouts.

## Sync procedure

Per repo, in this order (a dependency is synced before its dependent):

```bash
# 1. minipae  (no dependents to restart first)
ssh hostinger 'cd /opt/minipae     && git pull --ff-only'
# 2. agent-phone
ssh hostinger 'cd /opt/agent-phone && git pull --ff-only'
# 3. agent-voice  (imports both of the above)
ssh hostinger 'cd /opt/agent-voice && git pull --ff-only && systemctl restart agent-voice'
# 4. helixmain  (API + site)
ssh hostinger 'cd /root/helixmain  && git pull --ff-only && git submodule update --init --recursive'
ssh hostinger 'cd /root/helixmain/dna-foundry/api && npm run build && systemctl restart helix-api'
```

Then verify, do not assume:

```bash
ssh hostinger 'systemctl is-active agent-voice helix-api'
bash infra/verify-nginx-sync.sh                 # repo nginx config == live
node --test dna-foundry/mcp/helix-mcp.test.js   # MCP surface
```

### Traps this procedure exists to avoid

- **`git pull` piped to `tail -1` hides "Aborting".** A local mode-drift aborts
  the pull and the deploy *looks* successful while the host sits commits behind.
  Never pipe a deploy `git pull` through `tail`. Compare `git rev-parse HEAD`
  locally and on the host instead.
- **Submodules are not pulled by `git pull`.** `git submodule update --init
  --recursive` is a separate step; skip it and `vendor/card-protocol` silently
  stays at the old commit.
- **Executable bits.** `helix-mcp.js` and the `infra/*.sh` scripts must be
  committed `100755`. A mode drift on the host aborts the next pull (see above).
  Check with `git ls-files -s <path>`.

## Bumping a pin

1. Make the change in the dependency repo; commit and push it.
2. Update the ref: `git -C vendor/card-protocol fetch && git -C
   vendor/card-protocol checkout <sha>` then `git add vendor/card-protocol`
   (card-protocol), or edit the `@<sha>` in `agent-voice/requirements.txt`.
3. Update the "Current pins" block above.
4. Re-check the compatibility table if the bump touches the card format:
   `agent-os/contracts/card-format-compatibility.md`.
