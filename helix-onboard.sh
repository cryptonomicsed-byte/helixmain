#!/usr/bin/env bash
# helix-onboard — provision / update a per-company AI voice agent on the VPS
# Usage: helix-onboard <command> [options]
#
# Commands:
#   create  --id <slug> --name "..." --type <restaurant|service|retail>
#           --location "..." --phone "..." --hours "..." --pitch "..."
#           [--offerings "Item1, Item2"] [--policies "topic: rule | topic: rule"]
#           [--review-url "https://..."] [--socials "instagram:handle|facebook:handle"]
#           [--specials "name:description:price:valid_from:valid_to|..."]
#           [--sla "within 24 hours"] [--policy-donts "never do X|never do Y"]
#   update  --id <slug> [same optional fields; a field not passed keeps its value]
#   reload  --id <slug>
#   status  [--id <slug>]
#   qr      --id <slug>
#
# The card JSON is the source of truth: create/update author it via
# infra/build-card.py, then the DNA compiler (dna-foundry/compiler) derives
# CARD.md and every artifact. There is no second compiler.
set -euo pipefail

VPS="hostinger"
HELIX_DIR="/etc/helix/companies"
RELAY="wss://omokoda.duckdns.org:3443"
CALLER_BASE="https://omokoda.duckdns.org/caller/"
SPARK_BASE="https://omokoda.duckdns.org/spark/"
COMPILER="/root/helixmain/dna-foundry/compiler"

# LLM key: never hardcode. Provide via env (or a 0600 file) before running.
#   export DEEPSEEK_KEY=sk-...   # or set LLM_API_KEY instead
DEEPSEEK_KEY="${DEEPSEEK_KEY:-${LLM_API_KEY:-}}"
[[ -z "$DEEPSEEK_KEY" ]] && { echo "ERROR: DEEPSEEK_KEY (or LLM_API_KEY) is not set in the environment." >&2; exit 1; }

# ── helpers ───────────────────────────────────────────────────────────────────

usage() {
  grep '^#' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

die() { echo "ERROR: $*" >&2; exit 1; }

require_id() {
  [[ -z "${OPT_ID:-}" ]] && die "--id is required"
  [[ "$OPT_ID" =~ ^[a-z0-9-]+$ ]] || die "--id must be lowercase alphanumeric/hyphens, got: $OPT_ID"
}

parse_args() {
  OPT_ID=""; OPT_NAME=""; OPT_TYPE="service"; OPT_TYPE_GIVEN=0; OPT_LOCATION=""
  OPT_PHONE=""; OPT_HOURS=""; OPT_PITCH=""; OPT_OFFERINGS=""; OPT_POLICIES=""
  OPT_REVIEW_URL=""
  OPT_SOCIALS="" OPT_SPECIALS="" OPT_SLA="" OPT_POLICY_DONTS=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --id)           OPT_ID="$2";           shift 2 ;;
      --name)         OPT_NAME="$2";         shift 2 ;;
      --type)         OPT_TYPE="$2";         OPT_TYPE_GIVEN=1; shift 2 ;;
      --location)     OPT_LOCATION="$2";     shift 2 ;;
      --phone)        OPT_PHONE="$2";        shift 2 ;;
      --hours)        OPT_HOURS="$2";        shift 2 ;;
      --pitch)        OPT_PITCH="$2";        shift 2 ;;
      --offerings)    OPT_OFFERINGS="$2";    shift 2 ;;
      --policies)     OPT_POLICIES="$2";     shift 2 ;;
      --review-url)   OPT_REVIEW_URL="$2";   shift 2 ;;
      --socials)      OPT_SOCIALS="$2";      shift 2 ;;
      --specials)     OPT_SPECIALS="$2";     shift 2 ;;
      --sla)          OPT_SLA="$2";          shift 2 ;;
      --policy-donts) OPT_POLICY_DONTS="$2"; shift 2 ;;
      *) die "Unknown option: $1" ;;
    esac
  done
}

# Generate npub bech32 from pubkey hex using Python on VPS
derive_npub() {
  local pk_hex="$1"
  ssh "$VPS" python3 - "$pk_hex" << 'PYEOF'
import sys
pk_hex = sys.argv[1]
pk = bytes.fromhex(pk_hex)
CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
def polymod(v):
    chk = 1
    for b in v:
        t = chk >> 25
        chk = (chk & 0x1ffffff) << 5 ^ b
        for i in range(5):
            chk ^= GEN[i] if ((t >> i) & 1) else 0
    return chk
def hrp_expand(h):
    return [ord(c) >> 5 for c in h] + [0] + [ord(c) & 31 for c in h]
def conv(data, fb, tb):
    acc = bits = 0; ret = []
    for v in data:
        acc = ((acc << fb) | v) & 0xffffffff
        bits += fb
        while bits >= tb:
            bits -= tb
            ret.append((acc >> bits) & ((1 << tb) - 1))
    if bits: ret.append((acc << (tb - bits)) & ((1 << tb) - 1))
    return ret
d5 = conv(pk, 8, 5)
combined = d5 + [0]*6
pm = polymod(hrp_expand('npub') + combined) ^ 1
ck = [(pm >> (5*(5-i))) & 31 for i in range(6)]
print('npub' + '1' + ''.join(CHARSET[x] for x in d5 + ck))
PYEOF
}

# Generate keypair on VPS, return "SK_HEX PK_HEX"
gen_keypair() {
  ssh "$VPS" python3 - << 'PYEOF'
import sys, secrets
sys.path.insert(0, '/opt/minipae'); sys.path.insert(0, '/opt/agent-phone')
import minipae
sk = secrets.token_bytes(32)
pk_int = minipae.pubkey_from_secret(int.from_bytes(sk, 'big'))
pk = pk_int if isinstance(pk_int, bytes) else pk_int.to_bytes(32, 'big')
print(sk.hex(), pk.hex())
PYEOF
}

# ── Card authoring + compilation ──────────────────────────────────────────────
# The card JSON is the source of truth. build_card_json authors it — the one job
# onboarding owns. compile_card hands that card to the ONE compiler
# (dna-foundry/compiler), which derives CARD.md and every artifact from it.
# Nothing here reimplements the compiler; nothing here fabricates a hash.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_CARD="${SCRIPT_DIR}/infra/build-card.py"

# Author card.json from operator input. On update, pass the existing card.json
# path as the 16th argument; any field left empty keeps its current value.
build_card_json() {
  local id="$1" org_id="$2" name="$3" type="$4"
  local location="$5" phone="$6" hours="$7" pitch="$8"
  local offerings="$9" policies="${10}" review_url="${11:-}"
  local socials="${12:-}" specials="${13:-}" sla="${14:-}" policy_donts="${15:-}"
  local existing_file="${16:-}"
  local card_dir="${HELIX_DIR}/${id}"

  [[ -f "$BUILD_CARD" ]] || die "card builder not found: $BUILD_CARD"

  local args=(
    --id "$id" --org "$org_id" --name "$name" --type "$type"
    --location "$location" --phone "$phone" --hours "$hours" --pitch "$pitch"
    --offerings "$offerings" --policies "$policies" --review-url "$review_url"
    --socials "$socials" --specials "$specials" --sla "$sla"
    --policy-donts "$policy_donts"
  )
  [[ -n "$existing_file" ]] && args+=(--existing-file "$existing_file")

  python3 "$BUILD_CARD" "${args[@]}" \
    | ssh "$VPS" "cat > '${card_dir}/card.json'" \
    || die "failed to write ${card_dir}/card.json"
}

# Compile the authored card with the canonical compiler, verify the emitted
# CARD.md (hash + acting_hash), then copy the compiler's REAL hashes into
# card.json so JSON consumers (spark-gate's acting_hash pin, agentCompiler's
# hash snip) never see a fabricated zero again.
compile_card() {
  local id="$1"
  local card_dir="${HELIX_DIR}/${id}"

  echo "--> Compiling ${id}..."
  ssh "$VPS" "set -e
    cd '${COMPILER}'
    [ -d node_modules ] || { echo 'ERROR: no node_modules in ${COMPILER} — run npm ci there' >&2; exit 1; }
    node dist/cli.js --card '${card_dir}/card.json' --out '${card_dir}'
    node dist/cli.js --verify-md --md '${card_dir}/CARD.md'
  " || die "compile or verify failed for ${id}"

  ssh "$VPS" python3 - "'${card_dir}'" << 'PYEOF' || die "could not fold hashes into card.json for ${id}"
import json, re, sys
card_dir = sys.argv[1]
md = open(f"{card_dir}/CARD.md").read()
def fm(key):
    m = re.search(rf"^{key}:\s*(?:sha256:)?([0-9a-f]{{64}})\s*$", md, re.M)
    return m.group(1) if m else ""
card = json.load(open(f"{card_dir}/card.json"))
card["hash"] = fm("hash")
card["acting_hash"] = fm("acting_hash")
json.dump(card, open(f"{card_dir}/card.json", "w"), indent=2)
print(f"    card.json: hash={card['hash'][:16]}... acting_hash={card['acting_hash'][:16]}...")
PYEOF
}

# Show QR for caller URL locally using Python
show_qr() {
  local url="$1"
  echo "Caller URL: $url"
  python3 - "$url" << 'PYEOF' 2>/dev/null || true
import sys, qrcode
url = sys.argv[1]
qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_L, box_size=10, border=4)
qr.add_data(url); qr.make(fit=True)
img = qr.make_image(fill_color="black", back_color="white")
out = "/data/data/com.termux/files/home/caller-qr-latest.png"
img.save(out)
print(f"QR saved: {out}")
PYEOF
}


url_encode() {
  python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$1"
}

# ── Commands ──────────────────────────────────────────────────────────────────

# Trigger Hugo site rebuild on VPS via the installed watcher rebuild script
trigger_site_rebuild() {
  echo "--> Triggering site rebuild..."
  ssh "$VPS" "bash /opt/helix/helix-rebuild.sh" 2>&1 | tail -5 \
    || echo "    rebuild script not installed yet, run: bash infra/install-watcher.sh"
}

# Call agentCompiler API to generate role-specific files (sales/content/owner-manager)
post_compile_roles() {
  local id="$1"
  local card_dir="${HELIX_DIR}/${id}"
  local compiled_dir="${card_dir}/compiled"

  echo "--> Compiling agent roles for ${id}..."
  # If the API is running locally, call it. Otherwise skip gracefully.
  if curl -sf http://localhost:3000/health > /dev/null 2>&1; then
    curl -sf -X POST http://localhost:3000/compile \
      -H "Content-Type: application/json" \
      -d "{\"cardId\":\"${id}\",\"companyId\":\"${id}\"}" \
      > /dev/null && echo "    roles compiled" || echo "    compile API unavailable, skipping role files"
  else
    echo "    compile API not running, skipping role files"
  fi
}

# Append per-company ZeroClaw config blocks (single-file config, no includes support)
append_zeroclaw_config() {
  local id="$1"
  local sk_hex="$2"
  local card_dir="${HELIX_DIR}/${id}"
  local zc_config="/etc/zeroclaw/config.toml"
  local ts; ts="$(date -u +%Y%m%d%H%M%S)"

  # Guard: skip if already present
  if ssh "$VPS" "grep -q '^\[agents\.${id}\]' '${zc_config}'" 2>/dev/null; then
    echo "    zeroclaw: [agents.${id}] already present, skipping"
    return 0
  fi

  echo "--> Appending ZeroClaw config for ${id}..."
  ssh "$VPS" "cp '${zc_config}' '${zc_config}.bak-onboard-${ts}'"

  ssh "$VPS" "cat >> '${zc_config}'" << ZCEOF

# ─── Company: ${id} ───────────────────────────────────────────────────────────

[agents.${id}]
acp_enable_mcp = false
delegate_same_risk_profile = true
enabled = true
model_provider = "openai.deepseek"
risk_profile = "card_agent"
mcp_bundles = ["${id}_tools"]
channels = ["nostr.${id}"]
knowledge_bundles = ["${id}_card"]

[agents.${id}.a2a]
published = false

[agents.${id}.identity]
format = "openclaw"

[agents.${id}.memory]
backend = "sqlite"

[agents.${id}.precheck]
enabled = true
timeout_secs = 5

[agents.${id}.workspace]
unrestricted_filesystem = false

[channels.nostr.${id}]
enabled = true
private_key = "${sk_hex}"
relays = ["wss://omokoda.duckdns.org:3443"]

[peer_groups.${id}_trusted]
channel = "nostr.${id}"
agents = ["${id}"]
external_peers = []

[[mcp.servers]]
name = "spark_${id}"
transport = "stdio"
command = "/usr/local/bin/spark-gate-mcp"
args = []
tool_timeout_secs = 30
pinned_resources = ["card://local/current"]
env = { SPARK_INVOKE_URL = "http://127.0.0.1:9100/invoke", SPARK_CARD = "${card_dir}/card.json", SPARK_POLICY_SEED = "${card_dir}/policy-seed.json", SPARK_TOOL_ALLOWLIST = "${card_dir}/tool-allowlist.json" }

[mcp_bundles.${id}_tools]
servers = ["spark_${id}"]
exclude = []

[knowledge_bundles.${id}_card]
sources = ["${card_dir}/CARD.md"]
tags = ["card", "${id}"]

# ─── Internal role agents: ${id} ──────────────────────────────────────────────

[agents.${id}-sales]
acp_enable_mcp = false
delegate_same_risk_profile = true
enabled = true
model_provider = "openai.deepseek"
risk_profile = "card_agent"
mcp_bundles = ["${id}_tools"]
knowledge_bundles = ["${id}_card", "${id}_intel"]

[agents.${id}-sales.a2a]
published = false

[agents.${id}-sales.identity]
format = "openclaw"

[agents.${id}-sales.memory]
backend = "sqlite"

[agents.${id}-sales.precheck]
enabled = true
timeout_secs = 5

[agents.${id}-sales.workspace]
unrestricted_filesystem = false

[agents.${id}-content]
acp_enable_mcp = false
delegate_same_risk_profile = true
enabled = true
model_provider = "openai.deepseek"
risk_profile = "card_agent"
mcp_bundles = ["${id}_tools"]
knowledge_bundles = ["${id}_card"]

[agents.${id}-content.a2a]
published = false

[agents.${id}-content.identity]
format = "openclaw"

[agents.${id}-content.memory]
backend = "sqlite"

[agents.${id}-content.precheck]
enabled = true
timeout_secs = 5

[agents.${id}-content.workspace]
unrestricted_filesystem = false

[agents.${id}-owner]
acp_enable_mcp = false
delegate_same_risk_profile = false
enabled = true
model_provider = "openai.deepseek"
risk_profile = "owner_agent"
mcp_bundles = ["${id}_tools"]
knowledge_bundles = ["${id}_card", "${id}_intel"]

[agents.${id}-owner.a2a]
published = false

[agents.${id}-owner.identity]
format = "openclaw"

[agents.${id}-owner.memory]
backend = "sqlite"

[agents.${id}-owner.precheck]
enabled = true
timeout_secs = 5

[agents.${id}-owner.workspace]
unrestricted_filesystem = false

[knowledge_bundles.${id}_intel]
sources = ["${card_dir}/compiled/sales/memory.md", "${card_dir}/compiled/owner-manager/memory.md"]
tags = ["intel", "${id}"]
ZCEOF

  echo "--> Restarting ZeroClaw..."
  ssh "$VPS" "systemctl restart zeroclaw"
  sleep 3
  local zc_active; zc_active="$(ssh "$VPS" "systemctl is-active zeroclaw" 2>/dev/null || echo inactive)"
  echo "    zeroclaw: ${zc_active}"
  if [[ "$zc_active" != "active" ]]; then
    echo "    WARNING: zeroclaw not active — restoring backup and retrying"
    ssh "$VPS" "cp '${zc_config}.bak-onboard-${ts}' '${zc_config}' && systemctl restart zeroclaw"
    die "ZeroClaw failed to start with new config. Backup restored."
  fi
}

cmd_create() {
  parse_args "$@"
  require_id
  [[ -z "$OPT_NAME" ]]     && die "--name is required"
  [[ -z "$OPT_LOCATION" ]] && die "--location is required"
  [[ -z "$OPT_PHONE" ]]    && die "--phone is required"
  [[ -z "$OPT_HOURS" ]]    && die "--hours is required"
  [[ -z "$OPT_PITCH" ]]    && OPT_PITCH="$OPT_NAME"

  local id="$OPT_ID"
  local org_id="org_${id//-/_}"
  local dna_id="dna_$(openssl rand -hex 4)"
  local card_dir="${HELIX_DIR}/${id}"

  echo "==> Creating company: ${id} (${OPT_NAME})"

  # 1. Create directory on VPS
  ssh "$VPS" "mkdir -p '${card_dir}' '/var/lib/helix/${id}'"

  # 2. Generate keypair
  echo "--> Generating keypair..."
  read -r SK_HEX PK_HEX <<< "$(gen_keypair)"
  NPUB="$(derive_npub "$PK_HEX")"
  echo "    npub: $NPUB"

  # 3. Write identity and seckey
  ssh "$VPS" "echo '${SK_HEX}' > '${card_dir}/seckey' && chmod 600 '${card_dir}/seckey'"
  ssh "$VPS" "printf '%s\n%s\n%s\n' '${SK_HEX}' '${PK_HEX}' '${NPUB}' > '${card_dir}/identity'"

  # 4. Author card.json (the source of truth) from operator input
  echo "--> Writing card.json..."
  build_card_json "$id" "$org_id" "$OPT_NAME" "$OPT_TYPE" \
    "$OPT_LOCATION" "$OPT_PHONE" "$OPT_HOURS" "$OPT_PITCH" \
    "$OPT_OFFERINGS" "$OPT_POLICIES" "$OPT_REVIEW_URL" \
    "$OPT_SOCIALS" "$OPT_SPECIALS" "$OPT_SLA" "$OPT_POLICY_DONTS"

  # 5. Compile the card -> CARD.md + system-prompt + policy-seed + allowlist + hugo
  compile_card "$id"
  post_compile_roles "$id"

  # 6. Write env file
  ssh "$VPS" "cat > '${card_dir}/env'" << ENVEOF
LLM_API_KEY=${DEEPSEEK_KEY}
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_MODEL=deepseek-chat
AGENT_VOICE_RELAYS=${RELAY}
AGENT_VOICE_STATE=/var/lib/helix/${id}
AGENT_VOICE_CARD=${card_dir}/card.json
AGENT_VOICE_SECKEY=${SK_HEX}
DEEPSEEK_API_KEY=${DEEPSEEK_KEY}
ENVEOF

  # 7. Write systemd unit
  local svc_name="agent-voice-${id}"
  ssh "$VPS" "cat > '/etc/systemd/system/${svc_name}.service'" << SVCEOF
[Unit]
Description=Helix Agent Voice — ${OPT_NAME}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${card_dir}/env
ExecStart=/opt/agent-voice-venv/bin/python -m agent_voice
WorkingDirectory=/opt/agent-voice
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SVCEOF

  # 8. Enable and start
  echo "--> Starting ${svc_name}..."
  ssh "$VPS" "systemctl daemon-reload && systemctl enable --now '${svc_name}'"
  sleep 3
  local active; active="$(ssh "$VPS" "systemctl is-active '${svc_name}'" 2>/dev/null || echo inactive)"
  echo "    service: $active"

  # 8.5. Append ZeroClaw config (text agent for DMs)
  append_zeroclaw_config "$id" "$SK_HEX"

  # 9. Print summary + QR
  local caller_url="${CALLER_BASE}?npub=${NPUB}&relay=$(url_encode "$RELAY")&name=$(url_encode "$OPT_NAME")"
  local spark_url="${SPARK_BASE}?org=${org_id}"

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Company:    ${OPT_NAME}"
  echo "  ID:         ${id}"
  echo "  Org:        ${org_id}"
  echo "  Service:    ${svc_name} [${active}]"
  echo "  npub:       ${NPUB}"
  echo "  Caller URL: ${caller_url}"
  echo "  Approval:   ${spark_url}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  show_qr "$caller_url"
  trigger_site_rebuild
}

cmd_update() {
  parse_args "$@"
  require_id
  local id="$OPT_ID"
  local card_dir="${HELIX_DIR}/${id}"

  ssh "$VPS" "test -d '${card_dir}'" || die "Company '${id}' not found. Run create first."

  echo "==> Updating company: ${id}"

  # card-first update: read the existing card.json, let build_card_json merge the
  # provided fields over it (an empty option keeps the current value), then
  # compile. No CARD.md grep-scraping, no re-render — the builder merges, the
  # compiler derives, and only the compiler computes hashes.
  if [[ -n "$OPT_NAME" || -n "$OPT_LOCATION" || -n "$OPT_PHONE" || \
        -n "$OPT_HOURS" || -n "$OPT_PITCH" || -n "$OPT_OFFERINGS" || \
        -n "$OPT_POLICIES" || -n "$OPT_REVIEW_URL" || \
        -n "$OPT_SOCIALS" || -n "$OPT_SPECIALS" || -n "$OPT_SLA" || \
        -n "$OPT_POLICY_DONTS" || "${OPT_TYPE_GIVEN:-0}" == "1" ]]; then
    echo "--> Fetching existing card..."
    local existing_file="${HOME}/.helix/cards/${id}.json"
    mkdir -p "$(dirname "$existing_file")"
    ssh "$VPS" "cat '${card_dir}/card.json'" > "$existing_file" \
      || die "could not read ${card_dir}/card.json"

    local org_id
    org_id="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("organization_id",""))' "$existing_file")"

    # --type only when the operator supplied one: parse_args' "service" default
    # must not silently overwrite an existing card's type.
    local type_arg=""
    [[ "${OPT_TYPE_GIVEN:-0}" == "1" ]] && type_arg="$OPT_TYPE"

    build_card_json "$id" "$org_id" "$OPT_NAME" "$type_arg" \
      "$OPT_LOCATION" "$OPT_PHONE" "$OPT_HOURS" "$OPT_PITCH" \
      "$OPT_OFFERINGS" "$OPT_POLICIES" "$OPT_REVIEW_URL" \
      "$OPT_SOCIALS" "$OPT_SPECIALS" "$OPT_SLA" "$OPT_POLICY_DONTS" \
      "$existing_file"

    compile_card "$id"
  fi

  cmd_reload_inner "$id"
  trigger_site_rebuild
}

cmd_reload_inner() {
  local id="$1"
  local svc_name="agent-voice-${id}"
  ssh "$VPS" "systemctl restart '${svc_name}'"
  sleep 2
  local active; active="$(ssh "$VPS" "systemctl is-active '${svc_name}'" 2>/dev/null || echo inactive)"
  echo "    ${svc_name}: ${active}"
}

cmd_reload() {
  parse_args "$@"
  require_id
  echo "==> Reloading: ${OPT_ID}"
  cmd_reload_inner "$OPT_ID"
}

cmd_status() {
  parse_args "$@"
  if [[ -n "${OPT_ID:-}" ]]; then
    local id="$OPT_ID"
    local card_dir="${HELIX_DIR}/${id}"
    local svc_name="agent-voice-${id}"
    echo "==> Status: ${id}"
    ssh "$VPS" "systemctl status '${svc_name}' --no-pager -n 5; echo; cat '${card_dir}/identity' | tail -1" 2>/dev/null | head -20
    local npub; npub="$(ssh "$VPS" "tail -1 '${card_dir}/identity'" 2>/dev/null || echo '?')"
    local org_id="org_${id//-/_}"
    echo "  Caller:   ${CALLER_BASE}?npub=${npub}&relay=${RELAY}"
    echo "  Approval: ${SPARK_BASE}?org=${org_id}"
  else
    echo "==> All companies:"
    ssh "$VPS" "ls '${HELIX_DIR}/' 2>/dev/null || echo '(none)'" | while read -r id; do
      [[ -z "$id" || "$id" == "(none)" ]] && continue
      local active; active="$(ssh "$VPS" "systemctl is-active 'agent-voice-${id}'" 2>/dev/null || echo '?')"
      echo "  ${id}  [${active}]"
    done
  fi
}

cmd_qr() {
  parse_args "$@"
  require_id
  local id="$OPT_ID"
  local org_id="org_${id//-/_}"
  local npub; npub="$(ssh "$VPS" "tail -1 '${HELIX_DIR}/${id}/identity'" 2>/dev/null)" \
    || die "Company '${id}' not found"
  local name; name="$(ssh "$VPS" "grep '{"'key":"name"'"}' '${HELIX_DIR}/${id}/CARD.md'" 2>/dev/null \
    | sed 's/.*"text":"\([^"]*\)".*/\1/' | head -1)" || name="$id"
  local caller_url="${CALLER_BASE}?npub=${npub}&relay=$(url_encode "$RELAY")&name=$(url_encode "$name")"
  echo "==> QR for: ${id}"
  show_qr "$caller_url"
  echo "  Approval: ${SPARK_BASE}?org=${org_id}"
}

# ── Entry point ───────────────────────────────────────────────────────────────

COMMAND="${1:-}"; shift || true
case "$COMMAND" in
  create) cmd_create "$@" ;;
  update) cmd_update "$@" ;;
  reload) cmd_reload "$@" ;;
  status) cmd_status "$@" ;;
  qr)     cmd_qr     "$@" ;;
  *)      usage ;;
esac
