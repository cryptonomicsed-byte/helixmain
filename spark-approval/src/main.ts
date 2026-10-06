import {
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";

// ── Types mirroring spark-gatekeeper Rust structs ─────────────────────────────

type Verdict =
  | "Allow"
  | { Deny: { reason: string } }
  | { Escalate: { reason: string } };

interface GateTrailEntry {
  principle: string;
  verdict: Verdict;
}

interface Action {
  id: string;
  session_id: string;
  kind: string;
  tool: string | null;
  payload: unknown;
  acting_hash: string;
  initiated_at: string;
}

interface HeldOperation {
  id: string;
  card_id: string;
  card_version: number;
  acting_hash: string;
  action_id: string;
  action_json: string;
  trail_json: string;
  proposed_at: string;
  expires_at: string;
  status: "pending" | "approved" | "denied" | "expired";
}

interface GovernanceReceipt {
  id: string;
  card_id: string;
  card_version: number;
  acting_hash: string;
  action_id: string;
  final_verdict: Verdict;
  trail: GateTrailEntry[];
  parent_receipt_hash: string | null;
  minted_at: string;
  signer_key: string;
  signature: string;
}

// ── Verdict rendering ─────────────────────────────────────────────────────────

function verdictLabel(v: Verdict): { text: string; cls: string } {
  if (v === "Allow") return { text: "Allow", cls: "verdict-allow" };
  if (typeof v === "object" && "Deny" in v)
    return { text: `Deny — ${v.Deny.reason}`, cls: "verdict-deny" };
  if (typeof v === "object" && "Escalate" in v)
    return { text: `Escalate — ${v.Escalate.reason}`, cls: "verdict-escalate" };
  return { text: String(v), cls: "" };
}

// ── API calls ─────────────────────────────────────────────────────────────────

async function fetchHeld(): Promise<HeldOperation[]> {
  const resp = await fetch("/held");
  if (!resp.ok) throw new Error(`GET /held → ${resp.status}`);
  return resp.json();
}

async function postDeny(holdId: string): Promise<void> {
  const resp = await fetch(`/held/${holdId}/deny`, { method: "POST" });
  if (!resp.ok) throw new Error(`POST /held/${holdId}/deny → ${resp.status}`);
}

async function approveHold(
  holdId: string,
  parentReceiptHash: string | null,
): Promise<GovernanceReceipt> {
  // Step 1: get a WebAuthn challenge bound to this hold.
  const chalResp = await fetch(`/held/${holdId}/challenge`, { method: "POST" });
  if (!chalResp.ok) {
    const body = await chalResp.text();
    throw new Error(`challenge failed (${chalResp.status}): ${body}`);
  }
  const chalJSON = await chalResp.json();

  // Step 2: browser ceremony — authenticator signs the challenge.
  // webauthn-rs sends { publicKey: PublicKeyCredentialRequestOptions }.
  const credential = await startAuthentication(chalJSON.publicKey);

  // Step 3: send assertion + optional chain hash → Rust verifies → approves → mints.
  const approveResp = await fetch(`/held/${holdId}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ credential, parent_receipt_hash: parentReceiptHash }),
  });
  if (!approveResp.ok) {
    const body = await approveResp.text();
    throw new Error(`approve failed (${approveResp.status}): ${body}`);
  }
  return approveResp.json();
}

// ── Setup flow (passkey registration) ─────────────────────────────────────────

async function registerPasskey(
  userId: string,
  displayName: string,
): Promise<void> {
  const chalResp = await fetch("/setup/challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, display_name: displayName }),
  });
  if (!chalResp.ok) {
    const body = await chalResp.text();
    throw new Error(`setup/challenge failed (${chalResp.status}): ${body}`);
  }
  const chalJSON = await chalResp.json();

  const credential = await startRegistration(chalJSON.publicKey);

  const finishResp = await fetch("/setup/finish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, credential }),
  });
  if (!finishResp.ok) {
    const body = await finishResp.text();
    throw new Error(`setup/finish failed (${finishResp.status}): ${body}`);
  }
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of children)
    e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  return e;
}

function renderTrail(trailJson: string): HTMLElement {
  let trail: GateTrailEntry[] = [];
  try {
    trail = JSON.parse(trailJson);
  } catch {
    return el("div", { class: "trail" }, ["[trail parse error]"]);
  }
  const div = el("div", { class: "trail" });
  for (const entry of trail) {
    const { text, cls } = verdictLabel(entry.verdict);
    const row = el("div", { class: "trail-row" }, [
      el("span", { class: "principle" }, [entry.principle]),
      el("span", { class: cls }, [text]),
    ]);
    div.appendChild(row);
  }
  return div;
}

function renderAction(actionJson: string): string {
  try {
    const a: Action = JSON.parse(actionJson);
    const parts = [a.kind];
    if (a.tool) parts.push(`tool: ${a.tool}`);
    return parts.join(" · ");
  } catch {
    return actionJson;
  }
}

// ── Hold card rendering ───────────────────────────────────────────────────────

function renderHoldCard(item: HeldOperation): HTMLElement {
  const card = el("div", { class: "hold-card" });

  const header = el("div", { class: "hold-header" });
  const titleBlock = el("div", {});
  titleBlock.appendChild(
    el("div", { class: "hold-title" }, [
      renderAction(item.action_json),
    ]),
  );
  titleBlock.appendChild(
    el("div", { class: "hold-meta" }, [
      `${item.action_id} · card ${item.card_id}@${item.card_version} · `,
      `expires ${new Date(item.expires_at).toLocaleString()}`,
    ]),
  );
  header.appendChild(titleBlock);
  card.appendChild(header);
  card.appendChild(renderTrail(item.trail_json));

  const actions = el("div", { class: "actions" });
  const approveBtn = el("button", { class: "btn-approve" }, ["Approve"]);
  const denyBtn = el("button", { class: "btn-deny" }, ["Deny"]);
  actions.appendChild(approveBtn);
  actions.appendChild(denyBtn);
  card.appendChild(actions);

  const feedback = el("div", {});
  card.appendChild(feedback);

  approveBtn.addEventListener("click", async () => {
    approveBtn.disabled = true;
    denyBtn.disabled = true;
    feedback.innerHTML = "";
    try {
      const receipt = await approveHold(item.id, null);
      const box = el("div", { class: "receipt-box" }, [
        `✓ Approved · receipt ${receipt.id}\n`,
        `sig: ${receipt.signature.slice(0, 24)}…`,
      ]);
      feedback.appendChild(box);
      approveBtn.textContent = "Approved";
      setTimeout(() => refresh(), 1500);
    } catch (err) {
      approveBtn.disabled = false;
      denyBtn.disabled = false;
      feedback.appendChild(
        el("div", { class: "error-box" }, [String(err)]),
      );
    }
  });

  denyBtn.addEventListener("click", async () => {
    denyBtn.disabled = true;
    approveBtn.disabled = true;
    try {
      await postDeny(item.id);
      card.style.opacity = "0.4";
      setTimeout(() => refresh(), 800);
    } catch (err) {
      denyBtn.disabled = false;
      approveBtn.disabled = false;
      feedback.appendChild(
        el("div", { class: "error-box" }, [String(err)]),
      );
    }
  });

  return card;
}

// ── Setup section ─────────────────────────────────────────────────────────────

function renderSetup(): HTMLElement {
  const section = el("div", { class: "setup-section" });
  section.appendChild(el("h2", {}, ["Register Approver Passkey"]));

  const userIdInput = el("input", {
    type: "text",
    placeholder: "user id (e.g. justin)",
    value: "approver",
  }) as HTMLInputElement;
  const displayNameInput = el("input", {
    type: "text",
    placeholder: "display name",
    value: "SparkGatekeeper Approver",
  }) as HTMLInputElement;
  const registerBtn = el("button", { class: "btn-approve" }, [
    "Register Passkey",
  ]);
  const feedback = el("div", {});

  section.appendChild(userIdInput);
  section.appendChild(displayNameInput);
  section.appendChild(registerBtn);
  section.appendChild(feedback);

  registerBtn.addEventListener("click", async () => {
    registerBtn.disabled = true;
    feedback.innerHTML = "";
    try {
      await registerPasskey(userIdInput.value.trim(), displayNameInput.value.trim());
      feedback.appendChild(
        el("div", { class: "receipt-box" }, ["✓ Passkey registered"]),
      );
    } catch (err) {
      registerBtn.disabled = false;
      feedback.appendChild(
        el("div", { class: "error-box" }, [String(err)]),
      );
    }
  });

  return section;
}

// ── Main render loop ──────────────────────────────────────────────────────────

const app = document.getElementById("app")!;

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

async function refresh(): Promise<void> {
  if (refreshTimer) clearTimeout(refreshTimer);
  try {
    const items = await fetchHeld();
    app.innerHTML = "";
    app.appendChild(renderSetup());

    const queueHeader = el("h2", {}, [
      `Pending (${items.length}) — auto-refreshes every 10s`,
    ]);
    app.appendChild(queueHeader);

    if (items.length === 0) {
      app.appendChild(el("div", { class: "empty" }, ["No pending approvals."]));
    } else {
      for (const item of items) {
        app.appendChild(renderHoldCard(item));
      }
    }
  } catch (err) {
    app.innerHTML = "";
    app.appendChild(
      el("div", { class: "error-box" }, [`Failed to load queue: ${err}`]),
    );
  }
  refreshTimer = setTimeout(() => refresh(), 10_000);
}

refresh();
