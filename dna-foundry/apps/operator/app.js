/* Helix DNA Foundry — operator UI (md-primary).
   CARD.md is the primary surface: it renders here first, the JSON card is
   shown as the compiled machine view, and the diff is a line diff of the md.
   Files (written by demo.sh): CARD-v1.md, CARD-v2.md,
   sample-card.json, sample-card-v2.json. */

async function loadText(name) {
  const r = await fetch(name);
  return r.ok ? r.text() : null;
}

function el(id) { return document.getElementById(id); }

/* ---------- frontmatter ---------- */
function splitFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return [{}, md];
  const fm = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return [fm, m[2]];
}

/* ---------- tiny md renderer (our emitter's output is predictable) ---------- */
function inline(s) {
  return s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
}
function renderMd(body) {
  const out = [];
  let list = [];
  const flush = () => {
    if (list.length) { out.push("<ul>" + list.map((x) => `<li>${inline(x)}</li>`).join("") + "</ul>"); list = []; }
  };
  for (let line of body.split("\n")) {
    line = line.replace(/\s+$/, "");
    if (line.startsWith("### ")) { flush(); out.push(`<h3>${inline(line.slice(4))}</h3>`); }
    else if (line.startsWith("## ")) { flush(); out.push(`<h2>${inline(line.slice(3))}</h2>`); }
    else if (line.startsWith("# ")) { flush(); out.push(`<h1>${inline(line.slice(2))}</h1>`); }
    else if (/^\s*-\s/.test(line)) list.push(line.replace(/^\s*-\s/, ""));
    else if (line === "---") { flush(); out.push("<hr>"); }
    else if (line.trim() === "") flush();
    else { flush(); out.push(`<p>${inline(line)}</p>`); }
  }
  flush();
  return out.join("\n");
}

/* ---------- LCS line diff ---------- */
function lineDiff(a, b) {
  const A = a.split("\n"), B = b.split("\n");
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const rows = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { rows.push(["same", A[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { rows.push(["del", A[i]]); i++; }
    else { rows.push(["add", B[j]]); j++; }
  }
  while (i < n) rows.push(["del", A[i++]]);
  while (j < m) rows.push(["add", B[j++]]);
  return rows;
}
function renderDiff(rows) {
  return rows.map(([cls, line]) =>
    `<div class="dl ${cls}"><span class="gutter">${cls === "add" ? "+" : cls === "del" ? "−" : " "}</span><span>${inline(line) || " "}</span></div>`
  ).join("");
}

/* ---------- tabs ---------- */
function selectTab(name) {
  const go = () => {
    document.querySelectorAll(".tab").forEach((t) =>
      t.classList.toggle("active", t.dataset.tab === name));
    document.querySelectorAll(".view").forEach((v) =>
      (v.hidden = v.id !== "tab-" + name));
  };
  if (document.startViewTransition) document.startViewTransition(go); else go();
}

/* ---------- init ---------- */
(async function init() {
  const md2 = await loadText("CARD-v3.md");
  if (!md2) {
    el("md-body").innerHTML = "<p>Run <code>./demo.sh</code> to mint a CARD.md, then reload.</p>";
    el("diff-tab").disabled = true;
    return;
  }
  const [fm, body] = splitFrontmatter(md2);
  el("card-id").textContent = fm.id || "—";
  el("card-ver").textContent = "v" + (fm.version || "?");
  el("card-hash").textContent = "⛨ " + (fm.hash || "").slice(0, 12) + "…";
  el("card-hash").title = "canonical SHA-256: " + (fm.hash || "");
  const env = el("envelope");
  env.innerHTML = ["format", "id", "version", "previous_hash", "hash", "status"]
    .filter((k) => fm[k]).map((k) =>
      `<dt>${k}</dt><dd class="mono">${fm[k] || "—"}</dd>`).join("");
  el("hash-note").textContent =
    "Tamper-evident: hash covers the canonical JSON of this card. " +
    "version + previous_hash chain every mutation.";
  el("md-body").innerHTML = renderMd(body);

  /* Sonic brand: asset refs become playable audio. The demo copies
     foundry/assets/<hash>.mp3 into apps/operator/assets/. */
  el("md-body").querySelectorAll("h3").forEach((h) => {
    if (!/sonic brand|^sound$/i.test(h.textContent || "")) return;
    let n = h.nextElementSibling;
    while (n && n.tagName !== "H2" && n.tagName !== "H3") {
      n.innerHTML = n.innerHTML.replace(
        /<code>(sha256:[0-9a-f]{64})<\/code>/g,
        (m, ref) => `<audio controls preload="none" src="assets/${ref.slice(7)}.mp3"></audio> <span class="asset-ref">${m}</span>`
      );
      n = n.nextElementSibling;
    }
  });

  const cardJson = await loadText("sample-card-v3.json");
  if (cardJson) el("json-body").textContent = JSON.stringify(JSON.parse(cardJson), null, 2);

  const md1 = await loadText("CARD-v1.md");
  if (md1) {
    const rows = lineDiff(md1, md2);
    const changes = rows.filter(([c]) => c !== "same").length;
    el("diff-sub").textContent = `CARD-v1.md → CARD-v3.md · ${changes} changed lines`;
    el("diff-body").innerHTML = renderDiff(rows);
  } else {
    el("diff-tab").disabled = true;
  }
  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => selectTab(t.dataset.tab)));
})();
