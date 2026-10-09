#!/usr/bin/env bash
# helix-onboard — provision / update a per-company AI voice agent on the VPS
# Usage: helix-onboard <command> [options]
#
# Commands:
#   create  --id <slug> --name "..." --type <restaurant|service|retail>
#           --location "..." --phone "..." --hours "..." --pitch "..."
#           [--offerings "Item1, Item2"] [--policies "refunds: text | allergens: text"]
#   update  --id <slug> [same optional fields]
#   reload  --id <slug>
#   status  [--id <slug>]
#   qr      --id <slug>
set -euo pipefail

VPS="hostinger"
HELIX_DIR="/etc/helix/companies"
RELAY="wss://omokoda.duckdns.org:3443"
CALLER_BASE="https://omokoda.duckdns.org/caller/"
SPARK_BASE="https://omokoda.duckdns.org/spark/"
DEEPSEEK_KEY="sk-da9a7ddf0b694d06877f10dce57b0196"
COMPILER="/opt/helixmain/dna-foundry/compiler"

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
  OPT_ID=""; OPT_NAME=""; OPT_TYPE="service"; OPT_LOCATION=""
  OPT_PHONE=""; OPT_HOURS=""; OPT_PITCH=""; OPT_OFFERINGS=""; OPT_POLICIES=""
  OPT_REVIEW_URL=""
  OPT_SOCIALS="" OPT_SPECIALS="" OPT_SLA="" OPT_POLICY_DONTS=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --id)           OPT_ID="$2";           shift 2 ;;
      --name)         OPT_NAME="$2";         shift 2 ;;
      --type)         OPT_TYPE="$2";         shift 2 ;;
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

# Build offerings block for CARD.md
render_offerings() {
  local offerings="$1"
  if [[ -z "$offerings" ]]; then
    echo "- **Service** · kind: service · orderable: yes · price: null · confidence: 0.6"
    echo "<!-- machine:offering@1 {\"name\":\"Service\",\"kind\":\"service\",\"price\":null,\"orderable\":true,\"confidence\":0.6} -->"
    return
  fi
  IFS=',' read -ra items <<< "$offerings"
  for item in "${items[@]}"; do
    item="${item#"${item%%[![:space:]]*}"}"  # ltrim
    item="${item%"${item##*[![:space:]]}"}"  # rtrim
    [[ -z "$item" ]] && continue
    kind="service"
    echo "- **${item}** · kind: ${kind} · orderable: yes · price: null · confidence: 0.6"
    # escape quotes for JSON
    json_item="${item//\"/\\\"}"
    echo "<!-- machine:offering@1 {\"name\":\"${json_item}\",\"kind\":\"${kind}\",\"price\":null,\"orderable\":true,\"confidence\":0.6} -->"
  done
}

# Build specials block for CARD.md
# Input format: "name:description:price:valid_from:valid_to|..."
render_specials() {
  local specials="$1"
  [[ -z "$specials" ]] && return
  IFS='|' read -ra items <<< "$specials"
  for item in "${items[@]}"; do
    # item format: "name:description:price:valid_from:valid_to"
    IFS=':' read -r sname sdesc sprice sfrom sto <<< "$item"
    sname="${sname#"${sname%%[![:space:]]*}"}"
    sdesc="${sdesc#"${sdesc%%[![:space:]]*}"}"
    printf '- **Special:** %s — %s\n' "$sname" "$sdesc"
    printf '<!-- machine:special@1 {"name":"%s","description":"%s","price":%s,"valid_from":"%s","valid_to":"%s"} -->\n' \
      "$sname" "$sdesc" "${sprice:-null}" "${sfrom:-null}" "${sto:-null}"
  done
}

# Build socials block for CARD.md
# Input format: "instagram:handle|facebook:handle|x:handle"
render_socials() {
  local socials="$1"
  [[ -z "$socials" ]] && return
  IFS='|' read -ra items <<< "$socials"
  for item in "${items[@]}"; do
    IFS=':' read -r platform handle <<< "$item"
    platform="${platform#"${platform%%[![:space:]]*}"}"
    handle="${handle#"${handle%%[![:space:]]*}"}"
    printf '- **%s:** %s\n' "$platform" "$handle"
    printf '<!-- machine:social@1 {"platform":"%s","handle":"%s"} -->\n' "$platform" "$handle"
  done
}

# Build policy donts block for CARD.md
# Input format: "never do this|never do that"
render_policy_donts() {
  local donts="$1"
  [[ -z "$donts" ]] && return
  IFS='|' read -ra items <<< "$donts"
  for dont in "${items[@]}"; do
    dont="${dont#"${dont%%[![:space:]]*}"}"
    printf '- **Never:** %s\n' "$dont"
    printf '<!-- machine:policy_dont@1 {"text":"%s"} -->\n' "$dont"
  done
}

# Build policy block for CARD.md
render_policies() {
  local policies="$1"
  local name="$2"
  local phone="$3"
  # Always include a default refund policy
  if [[ -z "$policies" ]]; then
    echo "- **refunds:** Not satisfied? Call ${phone} and ask to speak with the manager — we'll make it right."
    echo "<!-- machine:policy@1 {\"topic\":\"refunds\",\"rule\":\"Not satisfied? Call ${phone} and ask to speak with the manager.\"} -->"
    return
  fi
  IFS='|' read -ra pols <<< "$policies"
  for pol in "${pols[@]}"; do
    pol="${pol#"${pol%%[![:space:]]*}"}"
    pol="${pol%"${pol##*[![:space:]]}"}"
    [[ -z "$pol" ]] && continue
    topic="${pol%%:*}"
    rule="${pol#*: }"
    topic="${topic// /_}"
    topic="${topic#"${topic%%[![:space:]]*}"}"
    json_topic="${topic//\"/\\\"}"
    json_rule="${rule//\"/\\\"}"
    echo "- **${topic}:** ${rule}"
    echo "<!-- machine:policy@1 {\"topic\":\"${json_topic}\",\"rule\":\"${json_rule}\"} -->"
  done
}

# Generate CARD.md content
render_card_md() {
  local id="$1" org_id="$2" name="$3" type="$4"
  local location="$5" phone="$6" hours="$7" pitch="$8"
  local offerings="$9" policies="${10}" review_url="${11:-}"
  local socials="${12:-}" specials="${13:-}" sla="${14:-}" policy_donts="${15:-}"
  local ts; ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local review_line=""
  if [[ -n "$review_url" ]]; then
    review_line="- **Reviews:** ${review_url}
<!-- machine:identity_value@1 {\"key\":\"review_url\",\"text\":\"${review_url}\"} -->"
  fi
  local socials_block=""
  if [[ -n "$socials" ]]; then
    socials_block="$(render_socials "$socials")"
  fi
  local sla_block=""
  if [[ -n "$sla" ]]; then
    sla_block="- **Response SLA:** ${sla}
<!-- machine:response_sla@1 {\"text\":\"${sla}\"} -->"
  fi
  local policy_donts_block=""
  if [[ -n "$policy_donts" ]]; then
    policy_donts_block="$(render_policy_donts "$policy_donts")"
  fi

  cat << CARDEOF
---
format: business-card/0.2
id: ${id}
version: 1
organization_id: ${org_id}
status: draft
updated: ${ts}
---

# ${name}

> ${pitch}

## Identity
- **Name:** ${name}
<!-- machine:identity_value@1 {"key":"name","text":"${name}"} -->
- **Pitch:** ${pitch}
<!-- machine:identity_value@1 {"key":"elevator_pitch","text":"${pitch}"} -->
- **Type:** ${type}
<!-- machine:identity_value@1 {"key":"type","text":"${type}"} -->
- **Address:** ${location}
<!-- machine:identity_value@1 {"key":"location","text":"${location}"} -->
- **Phone:** ${phone}
<!-- machine:identity_value@1 {"key":"phone","text":"${phone}"} -->
${review_line}
${socials_block}

## Voice
- **Tone:** warm, helpful, professional
- **Personality:** Friendly and knowledgeable representative for ${name}.
- **Don't:** Use cold, corporate or impersonal language.
<!-- machine:voice_dont@1 {"text":"Use cold, corporate or impersonal language."} -->
- **Don't:** Rush callers or make them feel unwelcome.
<!-- machine:voice_dont@1 {"text":"Rush callers or make them feel unwelcome."} -->

## Offer
$(render_offerings "$offerings")
$(render_specials "$specials")

## Operations
- **Hours:** ${hours}
<!-- machine:hour@1 {"text":"${hours}"} -->
- **Channel:** phone
<!-- machine:channel@1 {"name":"phone"} -->
${sla_block}

## Policy
$(render_policies "$policies" "$name" "$phone")
${policy_donts_block}

## Knowledge
General information about ${name} located at ${location}.
<!-- machine:knowledge@1 {"text":"General information about ${name} located at ${location}."} -->
CARDEOF
}

# Generate card.json on VPS directly from CARD.md fields (no compiler needed)
compile_card() {
  local id="$1"
  local card_dir="${HELIX_DIR}/${id}"
  ssh "$VPS" python3 - "$card_dir" << 'PYEOF'
import sys, json, hashlib, re, datetime

card_dir = sys.argv[1]
md = open(f"{card_dir}/CARD.md").read()

def extract(pattern, default=""):
    m = re.search(pattern, md, re.MULTILINE)
    return m.group(1) if m else default

def extract_all(pattern):
    return re.findall(pattern, md)

def extract_json_all(pattern):
    results = []
    for m in re.finditer(pattern, md):
        try: results.append(json.loads(m.group(1)))
        except: pass
    return results

# Frontmatter
fm_id       = extract(r'^id:\s*(.+)$', 'dna_unknown')
fm_org      = extract(r'^organization_id:\s*(.+)$', 'org_unknown')
fm_version  = int(extract(r'^version:\s*(\d+)$', '1'))
fm_status   = extract(r'^status:\s*(.+)$', 'draft')
now         = datetime.datetime.utcnow().isoformat() + "Z"

# Identity values
identity = {}
for item in extract_json_all(r'machine:identity_value@1 ({[^}]+})'):
    identity[item.get("key","")] = item.get("text","")

# Offerings
offerings = extract_json_all(r'machine:offering@1 ({[^}]+})')

# Voice donts
donts = [x.get("text","") for x in extract_json_all(r'machine:voice_dont@1 ({[^}]+})')]

# Hours
hours = [x.get("text","") for x in extract_json_all(r'machine:hour@1 ({[^}]+})')]

# Channels
channels = [x.get("name","") for x in extract_json_all(r'machine:channel@1 ({[^}]+})')]

# Specials
specials = extract_json_all(r'machine:special@1 ({[^}]+})')

# Socials
socials = {}
for item in extract_json_all(r'machine:social@1 ({[^}]+})'):
    socials[item.get("platform","")] = item.get("handle","")

# Response SLA
sla_items = extract_json_all(r'machine:response_sla@1 ({[^}]+})')
response_sla = sla_items[0].get("text","") if sla_items else ""

# Policy donts
policy_donts = [x.get("text","") for x in extract_json_all(r'machine:policy_dont@1 ({[^}]+})')]

# Pipeline stages (default)
pipeline_stages = ["new", "contacted", "qualified", "converted", "lost"]

# Policies
policies = extract_json_all(r'machine:policy@1 ({[^}]+})')

# Knowledge
knowledge = [x.get("text","") for x in extract_json_all(r'machine:knowledge@1 ({[^}]+})')]

# Build card dict (no hash computation needed for agent-voice)
card = {
    "id": fm_id,
    "version": fm_version,
    "hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    "acting_hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    "organization_id": fm_org,
    "status": fm_status,
    "created_at": now,
    "identity": {**identity, "socials": socials},
    "voice": {
        "tone": "warm, helpful, professional",
        "personality": f"Friendly representative for {identity.get('name', 'the business')}.",
        "donts": donts,
    },
    "offerings": offerings,
    "specials": specials,
    "operations": {
        "hours": hours[0] if hours else "",
        "channels": [{"type": c, "handle": "", "verified": False} for c in channels],
        "pipeline_stages": pipeline_stages,
        "response_sla": response_sla,
    },
    "policies": policies,
    "policy_donts": policy_donts,
    "knowledge": knowledge,
}

out = f"{card_dir}/card.json"
with open(out, "w") as f:
    json.dump(card, f, indent=2)
print(f"compiled: {out} ({len(offerings)} offerings)")

# Derive policy-seed.json from card policies
HIGH_TOPICS = {"refund", "cancel", "return", "chargeback", "complaint", "dispute", "compensation"}
seed_rules = []
for p in policies:
    topic = p.get("topic", "")
    rule  = p.get("rule", "")
    is_high = any(w in topic.lower() or w in rule.lower() for w in HIGH_TOPICS)
    seed_rules.append({
        "topic":             topic,
        "rule":              rule,
        "risk":              "high" if is_high else "low",
        "verdict":           "approval_required" if is_high else "allow",
        "source_confidence": 0.65,
    })
seed = {
    "card_id":      fm_id,
    "card_version": fm_version,
    "generated_at": now,
    "rules":        seed_rules,
    "defaults":     {"low": "allow", "medium": "approval_required", "high": "escalate"},
}
seed_out = f"{card_dir}/policy-seed.json"
with open(seed_out, "w") as f:
    json.dump(seed, f, indent=2)

# Derive tool-allowlist.json — standard set; add telephony if phone channel present
tools = [
    {"tool": "kb.search",              "reason": "answer from approved knowledge base"},
    {"tool": "customer.lookup",        "reason": "read-only customer retrieval"},
    {"tool": "order.lookup",           "reason": "read-only order retrieval"},
    {"tool": "ticket.create",          "reason": "ticket creation is low-risk"},
    {"tool": "ticket.update",          "reason": "ticket updates are low-risk"},
    {"tool": "conversation.summarize", "reason": "summaries are read-only"},
]
if "phone" in channels:
    tools.append({"tool": "telephony.place_call", "reason": "phone channel present"})
allowlist = {"card_id": fm_id, "tools": tools}
allow_out = f"{card_dir}/tool-allowlist.json"
with open(allow_out, "w") as f:
    json.dump(allowlist, f, indent=2)
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

  # 4. Generate and upload CARD.md
  echo "--> Writing CARD.md..."
  local card_content
  card_content="$(render_card_md "$dna_id" "$org_id" "$OPT_NAME" "$OPT_TYPE" \
    "$OPT_LOCATION" "$OPT_PHONE" "$OPT_HOURS" "$OPT_PITCH" \
    "$OPT_OFFERINGS" "$OPT_POLICIES" "$OPT_REVIEW_URL" \
    "$OPT_SOCIALS" "$OPT_SPECIALS" "$OPT_SLA" "$OPT_POLICY_DONTS")"
  echo "$card_content" | ssh "$VPS" "cat > '${card_dir}/CARD.md'"

  # 5. Compile card
  echo "--> Compiling card..."
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
}

cmd_update() {
  parse_args "$@"
  require_id
  local id="$OPT_ID"
  local card_dir="${HELIX_DIR}/${id}"

  ssh "$VPS" "test -d '${card_dir}'" || die "Company '${id}' not found. Run create first."

  echo "==> Updating company: ${id}"

  # Read existing CARD.md and patch fields that were provided
  if [[ -n "$OPT_NAME" || -n "$OPT_LOCATION" || -n "$OPT_PHONE" || \
        -n "$OPT_HOURS" || -n "$OPT_PITCH" || -n "$OPT_OFFERINGS" || \
        -n "$OPT_POLICIES" || -n "$OPT_REVIEW_URL" || \
        -n "$OPT_SOCIALS" || -n "$OPT_SPECIALS" || -n "$OPT_SLA" || -n "$OPT_POLICY_DONTS" ]]; then
    echo "--> Fetching existing card..."
    local existing_card; existing_card="$(ssh "$VPS" "cat '${card_dir}/CARD.md'")"

    # Extract existing values using grep
    local cur_name cur_location cur_phone cur_hours cur_pitch cur_org cur_id
    cur_name="$(echo "$existing_card" | grep '{"key":"name"' | head -1 | sed 's/.*"text":"\([^"]*\)".*/\1/')"
    cur_location="$(echo "$existing_card" | grep '{"key":"location"' | head -1 | sed 's/.*"text":"\([^"]*\)".*/\1/')"
    cur_phone="$(echo "$existing_card" | grep '{"key":"phone"' | head -1 | sed 's/.*"text":"\([^"]*\)".*/\1/')"
    cur_hours="$(echo "$existing_card" | grep 'machine:hour' | head -1 | sed 's/.*"text":"\([^"]*\)".*/\1/')"
    cur_pitch="$(echo "$existing_card" | grep '{"key":"elevator_pitch"' | head -1 | sed 's/.*"text":"\([^"]*\)".*/\1/')"
    cur_org="$(echo "$existing_card" | grep '^organization_id:' | head -1 | awk '{print $2}')"
    cur_id="$(echo "$existing_card" | grep '^id:' | head -1 | awk '{print $2}')"

    # Extract existing offerings as comma-separated names (fallback when not overriding)
    local cur_offerings cur_policies cur_review_url
    local cur_socials cur_specials cur_sla cur_policy_donts
    cur_review_url="$(echo "$existing_card" | grep '{"key":"review_url"' | head -1 | sed 's/.*"text":"\([^"]*\)".*/\1/' || true)"
    cur_offerings="$(echo "$existing_card" | grep 'machine:offering' | \
      sed 's/.*"name":"\([^"]*\)".*/\1/' | paste -sd ',' -)"
    # Extract existing policies as pipe-separated "topic: rule" pairs
    cur_policies="$(echo "$existing_card" | grep 'machine:policy' | \
      python3 -c "
import sys, json, re
lines = sys.stdin.read().splitlines()
pairs = []
for l in lines:
    m = re.search(r'\{.*\}', l)
    if m:
        try:
            d = json.loads(m.group())
            pairs.append(d.get('topic','') + ': ' + d.get('rule',''))
        except: pass
print('|'.join(pairs))
")"
    # Extract existing socials as "platform:handle|..." pipe-separated pairs
    cur_socials="$(echo "$existing_card" | grep 'machine:social' | \
      python3 -c "
import sys, json, re
lines = sys.stdin.read().splitlines()
pairs = []
for l in lines:
    m = re.search(r'\{.*\}', l)
    if m:
        try:
            d = json.loads(m.group())
            pairs.append(d.get('platform','') + ':' + d.get('handle',''))
        except: pass
print('|'.join(pairs))
" || true)"
    # Extract existing specials as "name:description:price:valid_from:valid_to|..." pairs
    cur_specials="$(echo "$existing_card" | grep 'machine:special' | \
      python3 -c "
import sys, json, re
lines = sys.stdin.read().splitlines()
pairs = []
for l in lines:
    m = re.search(r'\{.*\}', l)
    if m:
        try:
            d = json.loads(m.group())
            price = d.get('price') if d.get('price') is not None else ''
            pairs.append(':'.join([d.get('name',''), d.get('description',''), str(price), d.get('valid_from','') or '', d.get('valid_to','') or '']))
        except: pass
print('|'.join(pairs))
" || true)"
    # Extract existing response SLA
    cur_sla="$(echo "$existing_card" | grep 'machine:response_sla' | head -1 | \
      python3 -c "
import sys, json, re
l = sys.stdin.read()
m = re.search(r'\{.*\}', l)
if m:
    try:
        d = json.loads(m.group())
        print(d.get('text',''))
    except: pass
" || true)"
    # Extract existing policy donts as pipe-separated list
    cur_policy_donts="$(echo "$existing_card" | grep 'machine:policy_dont' | \
      python3 -c "
import sys, json, re
lines = sys.stdin.read().splitlines()
pairs = []
for l in lines:
    m = re.search(r'\{.*\}', l)
    if m:
        try:
            d = json.loads(m.group())
            pairs.append(d.get('text',''))
        except: pass
print('|'.join(pairs))
" || true)"

    # Apply overrides
    [[ -n "$OPT_NAME" ]]      && cur_name="$OPT_NAME"
    [[ -n "$OPT_LOCATION" ]]  && cur_location="$OPT_LOCATION"
    [[ -n "$OPT_PHONE" ]]     && cur_phone="$OPT_PHONE"
    [[ -n "$OPT_HOURS" ]]     && cur_hours="$OPT_HOURS"
    [[ -n "$OPT_PITCH" ]]     && cur_pitch="$OPT_PITCH"
    [[ -z "$OPT_OFFERINGS" ]]    && OPT_OFFERINGS="$cur_offerings"
    [[ -z "$OPT_POLICIES" ]]     && OPT_POLICIES="$cur_policies"
    [[ -z "$OPT_REVIEW_URL" ]]   && OPT_REVIEW_URL="$cur_review_url"
    [[ -z "$OPT_SOCIALS" ]]      && OPT_SOCIALS="$cur_socials"
    [[ -z "$OPT_SPECIALS" ]]     && OPT_SPECIALS="$cur_specials"
    [[ -z "$OPT_SLA" ]]          && OPT_SLA="$cur_sla"
    [[ -z "$OPT_POLICY_DONTS" ]] && OPT_POLICY_DONTS="$cur_policy_donts"
    [[ -z "$OPT_TYPE" ]]         && OPT_TYPE="service"

    local new_card
    new_card="$(render_card_md "$cur_id" "$cur_org" "$cur_name" "$OPT_TYPE" \
      "$cur_location" "$cur_phone" "$cur_hours" "$cur_pitch" \
      "${OPT_OFFERINGS}" "${OPT_POLICIES}" "${OPT_REVIEW_URL}" \
      "${OPT_SOCIALS}" "${OPT_SPECIALS}" "${OPT_SLA}" "${OPT_POLICY_DONTS}")"
    echo "$new_card" | ssh "$VPS" "cat > '${card_dir}/CARD.md'"
    echo "--> Recompiling..."
    compile_card "$id"
  fi

  cmd_reload_inner "$id"
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
