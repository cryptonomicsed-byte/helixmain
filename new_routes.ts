
// ---------------------------------------------------------------------------
// Voice Agent Call Page  (public — NO auth required)
// ---------------------------------------------------------------------------

/** Build the animated orb call page HTML from card data */
function buildCallPageHtml(opts: {
  companyId: string;
  companyName: string;
  tagline: string;
  agentName: string;
}): string {
  const { companyId, companyName, tagline, agentName } = opts;
  const apiBase = process.env.HELIX_API_BASE || "/api";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="description" content="Talk to the AI agent for ${companyName}">
<title>Talk to ${agentName} — ${companyName}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #080b14;
    --surface: #0e1520;
    --surface2: #141d2b;
    --text: #e4eaf4;
    --text-muted: #4a6080;
    --primary: #4a9eff;
    --primary-dim: rgba(74,158,255,0.15);
    --green: #22c55e;
    --amber: #f59e0b;
    --purple: #a855f7;
    --red: #ef4444;
  }

  html, body {
    height: 100%;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    overflow-x: hidden;
  }

  /* ---- Particle canvas ---- */
  #particles {
    position: fixed;
    inset: 0;
    z-index: 0;
    opacity: 0.35;
    pointer-events: none;
  }

  /* ---- Grid overlay ---- */
  .grid-overlay {
    position: fixed;
    inset: 0;
    z-index: 0;
    pointer-events: none;
    background-image:
      linear-gradient(rgba(74,158,255,0.04) 1px, transparent 1px),
      linear-gradient(90deg, rgba(74,158,255,0.04) 1px, transparent 1px);
    background-size: 40px 40px;
  }

  /* ---- Main layout ---- */
  .app {
    position: relative;
    z-index: 1;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 2rem 1rem 3rem;
    gap: 1.5rem;
  }

  /* ---- Header ---- */
  .header {
    text-align: center;
    max-width: 480px;
  }
  .header h1 {
    font-size: clamp(1.4rem, 4vw, 2rem);
    font-weight: 700;
    letter-spacing: -0.02em;
    background: linear-gradient(135deg, var(--text) 0%, var(--primary) 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }
  .header p {
    font-size: .9rem;
    color: var(--text-muted);
    margin-top: .4rem;
  }

  /* ---- Orb container ---- */
  .orb-wrapper {
    position: relative;
    width: 220px;
    height: 220px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  /* Spinning ring (connecting state) */
  .ring-spin {
    position: absolute;
    inset: -8px;
    border-radius: 50%;
    border: 2px solid transparent;
    border-top-color: var(--primary);
    border-right-color: var(--primary);
    opacity: 0;
    transition: opacity 0.4s ease;
  }

  /* Ripple rings (speaking state) */
  .ripple {
    position: absolute;
    border-radius: 50%;
    border: 1.5px solid var(--primary);
    opacity: 0;
    pointer-events: none;
  }
  .ripple-1 { width: 240px; height: 240px; }
  .ripple-2 { width: 280px; height: 280px; animation-delay: 0.4s; }
  .ripple-3 { width: 320px; height: 320px; animation-delay: 0.8s; }

  /* Core orb */
  .orb {
    width: 180px;
    height: 180px;
    border-radius: 50%;
    position: relative;
    cursor: pointer;
    transition: transform 0.3s ease;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .orb:hover { transform: scale(1.05); }

  /* Orb layers */
  .orb-glow {
    position: absolute;
    inset: -20px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(74,158,255,0.25) 0%, transparent 70%);
    transition: background 0.5s ease, transform 0.5s ease;
  }
  .orb-body {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: radial-gradient(circle at 35% 35%, rgba(74,158,255,0.4) 0%, rgba(26,62,128,0.9) 50%, rgba(8,11,20,0.95) 100%);
    border: 1.5px solid rgba(74,158,255,0.3);
    transition: background 0.5s ease, border-color 0.5s ease;
    overflow: hidden;
  }
  .orb-inner-glow {
    position: absolute;
    inset: 15px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(74,158,255,0.15) 0%, transparent 60%);
    transition: background 0.5s ease;
  }

  /* Icon inside orb */
  .orb-icon {
    position: relative;
    z-index: 2;
    font-size: 2.8rem;
    transition: opacity 0.3s ease;
    user-select: none;
  }

  /* Waveform bars (thinking/speaking) */
  .wave-bars {
    position: absolute;
    bottom: 40px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    gap: 4px;
    align-items: flex-end;
    opacity: 0;
    transition: opacity 0.3s ease;
    z-index: 3;
  }
  .bar {
    width: 4px;
    border-radius: 2px;
    background: var(--primary);
    min-height: 6px;
    transition: height 0.15s ease, background 0.3s ease;
  }

  /* ---- Status text ---- */
  .status-text {
    font-size: 1rem;
    color: var(--text-muted);
    text-align: center;
    min-height: 1.5rem;
    transition: color 0.3s ease;
    letter-spacing: .02em;
  }
  .status-text.active { color: var(--primary); }

  /* ---- Start button ---- */
  .btn-start {
    padding: .85rem 2.5rem;
    border-radius: 50px;
    border: none;
    background: linear-gradient(135deg, var(--primary) 0%, #7c6aff 100%);
    color: #fff;
    font-size: 1.05rem;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 0 30px rgba(74,158,255,0.4);
    transition: transform 0.2s ease, box-shadow 0.2s ease, opacity 0.3s ease;
    letter-spacing: .03em;
  }
  .btn-start:hover { transform: translateY(-2px); box-shadow: 0 0 45px rgba(74,158,255,0.6); }
  .btn-start:active { transform: scale(0.97); }
  .btn-start.hidden { opacity: 0; pointer-events: none; }

  /* ---- Input area ---- */
  .input-area {
    display: flex;
    gap: .6rem;
    width: 100%;
    max-width: 500px;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.4s ease;
    flex-wrap: wrap;
  }
  .input-area.visible { opacity: 1; pointer-events: all; }
  .msg-input {
    flex: 1;
    min-width: 200px;
    padding: .75rem 1rem;
    border-radius: 12px;
    border: 1.5px solid rgba(74,158,255,0.25);
    background: var(--surface);
    color: var(--text);
    font-size: .95rem;
    outline: none;
    transition: border-color 0.2s ease;
    font-family: inherit;
  }
  .msg-input:focus { border-color: var(--primary); }
  .msg-input::placeholder { color: var(--text-muted); }
  .btn-send {
    padding: .75rem 1.4rem;
    border-radius: 12px;
    border: none;
    background: var(--primary);
    color: #fff;
    font-size: .9rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s ease, transform 0.15s ease;
    font-family: inherit;
  }
  .btn-send:hover { background: #6cb4ff; transform: translateY(-1px); }
  .btn-send:disabled { opacity: .5; cursor: not-allowed; transform: none; }

  /* ---- Transcript / activity log ---- */
  .transcript {
    width: 100%;
    max-width: 500px;
    max-height: 280px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: .5rem;
    padding-right: .25rem;
  }
  .transcript::-webkit-scrollbar { width: 4px; }
  .transcript::-webkit-scrollbar-track { background: transparent; }
  .transcript::-webkit-scrollbar-thumb { background: rgba(74,158,255,0.2); border-radius: 4px; }

  .msg {
    padding: .65rem .9rem;
    border-radius: 10px;
    font-size: .88rem;
    line-height: 1.5;
    max-width: 90%;
    animation: fadeUp 0.3s ease;
  }
  .msg.user {
    background: rgba(74,158,255,0.12);
    border: 1px solid rgba(74,158,255,0.2);
    align-self: flex-end;
    color: var(--text);
  }
  .msg.agent {
    background: var(--surface);
    border: 1px solid rgba(255,255,255,0.06);
    align-self: flex-start;
    color: var(--text);
  }
  .msg .sender {
    font-size: .72rem;
    color: var(--text-muted);
    margin-bottom: .2rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: .06em;
  }
  .msg.agent .sender { color: var(--primary); }

  /* ---- Agent name badge ---- */
  .agent-badge {
    font-size: .8rem;
    color: var(--text-muted);
    text-align: center;
    letter-spacing: .04em;
  }
  .agent-badge span {
    color: var(--primary);
    font-weight: 600;
  }

  /* ---- End call button ---- */
  .btn-end {
    padding: .55rem 1.3rem;
    border-radius: 50px;
    border: 1px solid rgba(239,68,68,0.4);
    background: transparent;
    color: #ef4444;
    font-size: .82rem;
    font-weight: 600;
    cursor: pointer;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.3s ease, background 0.2s ease;
    letter-spacing: .03em;
    font-family: inherit;
  }
  .btn-end.visible { opacity: 1; pointer-events: all; }
  .btn-end:hover { background: rgba(239,68,68,0.1); }

  /* ---- State-based animations ---- */

  /* Idle: slow gentle pulse */
  @keyframes orbIdle {
    0%, 100% { transform: scale(1); opacity: 1; }
    50% { transform: scale(1.04); opacity: 0.92; }
  }

  /* Connecting: faster pulse */
  @keyframes orbConnect {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.08); }
  }

  /* Spin ring */
  @keyframes spinRing {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  /* Listening: breathing */
  @keyframes orbListen {
    0%, 100% { transform: scale(1); }
    40% { transform: scale(1.1); }
    60% { transform: scale(0.97); }
  }

  /* Ripple out */
  @keyframes rippleOut {
    0% { transform: scale(0.85); opacity: 0.6; }
    100% { transform: scale(1.4); opacity: 0; }
  }

  /* Fade up */
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  /* State classes on .orb */
  .orb.idle .orb-glow { animation: orbIdle 3s ease-in-out infinite; }

  .orb.connecting .orb-glow { animation: orbConnect 1.2s ease-in-out infinite; }

  .orb.listening .orb-body {
    background: radial-gradient(circle at 35% 35%, rgba(34,197,94,0.4) 0%, rgba(15,60,30,0.9) 50%, rgba(8,11,20,0.95) 100%);
    border-color: rgba(34,197,94,0.4);
  }
  .orb.listening .orb-glow {
    background: radial-gradient(circle, rgba(34,197,94,0.2) 0%, transparent 70%);
    animation: orbListen 2.5s ease-in-out infinite;
  }

  .orb.thinking .orb-body {
    background: radial-gradient(circle at 35% 35%, rgba(245,158,11,0.4) 0%, rgba(60,40,10,0.9) 50%, rgba(8,11,20,0.95) 100%);
    border-color: rgba(245,158,11,0.4);
  }
  .orb.thinking .orb-glow {
    background: radial-gradient(circle, rgba(245,158,11,0.2) 0%, transparent 70%);
    animation: orbListen 0.8s ease-in-out infinite;
  }
  .orb.thinking .bar { background: var(--amber); }

  .orb.speaking .orb-body {
    background: radial-gradient(circle at 35% 35%, rgba(74,158,255,0.5) 0%, rgba(15,30,80,0.9) 50%, rgba(8,11,20,0.95) 100%);
    border-color: rgba(74,158,255,0.5);
  }
  .orb.speaking .orb-glow {
    background: radial-gradient(circle, rgba(74,158,255,0.3) 0%, transparent 70%);
    animation: orbIdle 1.2s ease-in-out infinite;
  }

  /* Ring spin active */
  .connecting .ring-spin { opacity: 1; animation: spinRing 1s linear infinite; }

  /* Ripples active */
  .speaking .ripple { animation: rippleOut 2.4s ease-out infinite; }

  @media (max-width: 480px) {
    .orb-wrapper { width: 180px; height: 180px; }
    .orb { width: 148px; height: 148px; }
    .ripple-1 { width: 200px; height: 200px; }
    .ripple-2 { width: 235px; height: 235px; }
    .ripple-3 { width: 265px; height: 265px; }
    .orb-icon { font-size: 2.2rem; }
  }
</style>
</head>
<body>
<canvas id="particles"></canvas>
<div class="grid-overlay"></div>

<div class="app" id="app">
  <div class="header">
    <h1>${companyName}</h1>
    <p>${tagline || "Talk to our AI voice agent — available 24/7"}</p>
  </div>

  <div class="agent-badge">Powered by <span>${agentName}</span></div>

  <div class="orb-wrapper" id="orbWrapper">
    <!-- Ripple rings (speaking) -->
    <div class="ripple ripple-1"></div>
    <div class="ripple ripple-2"></div>
    <div class="ripple ripple-3"></div>

    <!-- Spinning ring (connecting) -->
    <div class="ring-spin" id="ringSpin"></div>

    <!-- Core orb -->
    <div class="orb idle" id="orb">
      <div class="orb-glow"></div>
      <div class="orb-body">
        <div class="orb-inner-glow"></div>
        <!-- Waveform bars -->
        <div class="wave-bars" id="waveBars">
          <div class="bar" id="b1" style="height:12px"></div>
          <div class="bar" id="b2" style="height:20px"></div>
          <div class="bar" id="b3" style="height:28px"></div>
          <div class="bar" id="b4" style="height:16px"></div>
          <div class="bar" id="b5" style="height:24px"></div>
          <div class="bar" id="b6" style="height:10px"></div>
          <div class="bar" id="b7" style="height:20px"></div>
        </div>
      </div>
      <div class="orb-icon" id="orbIcon">🤖</div>
    </div>
  </div>

  <div class="status-text" id="statusText">Ready to connect</div>

  <button class="btn-start" id="btnStart" onclick="startCall()">✦ Start Call</button>

  <div class="input-area" id="inputArea">
    <input
      class="msg-input"
      id="msgInput"
      type="text"
      placeholder="Type your message…"
      maxlength="500"
      onkeydown="if(event.key==='Enter' && !event.shiftKey){event.preventDefault();sendMessage()}"
    />
    <button class="btn-send" id="btnSend" onclick="sendMessage()">Send →</button>
  </div>

  <div class="transcript" id="transcript"></div>

  <button class="btn-end" id="btnEnd" onclick="endCall()">✕ End Call</button>
</div>

<script>
(function() {
  // ---- State ----
  let state = 'idle'; // idle | connecting | listening | thinking | speaking
  let sessionId = null;
  let waveInterval = null;
  let speakTimeout = null;
  const COMPANY_ID = '${companyId}';
  const API_BASE = '${apiBase}';

  // ---- DOM refs ----
  const orb        = document.getElementById('orb');
  const orbWrapper  = document.getElementById('orbWrapper');
  const orbIcon     = document.getElementById('orbIcon');
  const ringSpin    = document.getElementById('ringSpin');
  const statusText  = document.getElementById('statusText');
  const btnStart    = document.getElementById('btnStart');
  const inputArea   = document.getElementById('inputArea');
  const msgInput    = document.getElementById('msgInput');
  const btnSend     = document.getElementById('btnSend');
  const transcript  = document.getElementById('transcript');
  const btnEnd      = document.getElementById('btnEnd');
  const waveBars    = document.getElementById('waveBars');
  const bars        = Array.from(document.querySelectorAll('.bar'));

  const icons = { idle: '🤖', connecting: '⟳', listening: '🎤', thinking: '✦', speaking: '🔊' };
  const statuses = {
    idle:       'Ready to connect',
    connecting: 'Connecting to agent…',
    listening:  'Listening…',
    thinking:   'Agent is thinking…',
    speaking:   'Agent is speaking…'
  };

  function setState(s) {
    state = s;
    orb.className = 'orb ' + s;
    orbWrapper.className = 'orb-wrapper ' + s;
    orbIcon.textContent = icons[s] || '🤖';
    statusText.textContent = statuses[s] || '';
    statusText.className = 'status-text' + (s !== 'idle' ? ' active' : '');

    // Wave bars visibility
    if (s === 'thinking' || s === 'speaking') {
      waveBars.style.opacity = '1';
      startWave(s);
    } else {
      waveBars.style.opacity = '0';
      stopWave();
    }

    // Input area
    if (s === 'listening') {
      inputArea.classList.add('visible');
      msgInput.focus();
    }

    // End button
    if (s !== 'idle') {
      btnEnd.classList.add('visible');
    } else {
      btnEnd.classList.remove('visible');
      inputArea.classList.remove('visible');
    }
  }

  function startWave(mode) {
    stopWave();
    const barHeights = [8, 16, 28, 20, 32, 14, 22];
    waveInterval = setInterval(() => {
      bars.forEach((b, i) => {
        const base = mode === 'thinking' ? 8 : 10;
        const amp  = mode === 'thinking' ? 14 : 22;
        b.style.height = (base + Math.random() * amp) + 'px';
      });
    }, 120);
  }

  function stopWave() {
    if (waveInterval) { clearInterval(waveInterval); waveInterval = null; }
    bars.forEach((b, i) => { b.style.height = [12,20,28,16,24,10,20][i] + 'px'; });
  }

  function addMessage(role, text) {
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    const sender = document.createElement('div');
    sender.className = 'sender';
    sender.textContent = role === 'user' ? 'You' : '${agentName}';
    div.appendChild(sender);
    const content = document.createElement('div');
    content.textContent = text;
    div.appendChild(content);
    transcript.appendChild(div);
    transcript.scrollTop = transcript.scrollHeight;
  }

  // ---- Particle canvas ----
  (function initParticles() {
    const canvas = document.getElementById('particles');
    const ctx = canvas.getContext('2d');
    let W = window.innerWidth, H = window.innerHeight;
    canvas.width = W; canvas.height = H;
    window.addEventListener('resize', () => {
      W = window.innerWidth; H = window.innerHeight;
      canvas.width = W; canvas.height = H;
    });
    const particles = Array.from({length: 55}, () => ({
      x: Math.random() * W, y: Math.random() * H,
      vx: (Math.random() - 0.5) * 0.3, vy: (Math.random() - 0.5) * 0.3,
      r: Math.random() * 1.8 + 0.4,
      a: Math.random() * 0.6 + 0.1
    }));
    function draw() {
      ctx.clearRect(0, 0, W, H);
      particles.forEach(p => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(74,158,255,' + p.a + ')';
        ctx.fill();
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0) p.x = W; if (p.x > W) p.x = 0;
        if (p.y < 0) p.y = H; if (p.y > H) p.y = 0;
      });
      requestAnimationFrame(draw);
    }
    draw();
  })();

  // ---- Start call ----
  window.startCall = async function() {
    setState('connecting');
    btnStart.classList.add('hidden');

    // Try to create a session — use the public /call-session endpoint
    try {
      const r = await fetch('/api/call-session/' + COMPANY_ID, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: COMPANY_ID })
      });
      if (r.ok) {
        const data = await r.json();
        sessionId = data.sessionId || data.session_id || 'demo-' + Date.now();
      } else {
        sessionId = 'demo-' + Date.now();
      }
    } catch {
      sessionId = 'demo-' + Date.now();
    }

    setTimeout(() => {
      setState('listening');
      addMessage('agent', 'Hello! I\'m ${agentName}, the AI assistant for ${companyName}. How can I help you today?');
    }, 1200);
  };

  // ---- Send message ----
  window.sendMessage = async function() {
    const text = msgInput.value.trim();
    if (!text || state === 'thinking') return;

    msgInput.value = '';
    addMessage('user', text);
    setState('thinking');
    btnSend.disabled = true;

    try {
      const r = await fetch('/api/call-message/' + COMPANY_ID, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, message: text, companyId: COMPANY_ID })
      });

      let reply;
      if (r.ok) {
        const data = await r.json();
        reply = data.reply || data.text || data.message || 'I received your message. Let me look into that for you.';
      } else {
        reply = 'I\'m having a moment — could you say that again?';
      }

      setState('speaking');
      addMessage('agent', reply);

      if (speakTimeout) clearTimeout(speakTimeout);
      speakTimeout = setTimeout(() => {
        setState('listening');
        btnSend.disabled = false;
        msgInput.focus();
      }, Math.max(2000, reply.length * 35));

    } catch (e) {
      setState('listening');
      btnSend.disabled = false;
      addMessage('agent', 'I lost connection for a moment. Please try again.');
    }
  };

  // ---- End call ----
  window.endCall = function() {
    if (speakTimeout) clearTimeout(speakTimeout);
    stopWave();
    sessionId = null;
    setState('idle');
    btnStart.classList.remove('hidden');
    transcript.innerHTML = '';
  };

  // Initialize
  setState('idle');
})();
</script>
</body>
</html>`;
}

// GET /call/:companyId — public animated voice agent call page (NO auth)
app.get("/call/:companyId", async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  if (!companyId || companyId.includes("/") || companyId.includes("..")) {
    return reply.code(400).send("invalid companyId");
  }

  let companyName = "Helix Agent";
  let tagline = "Talk to our AI voice agent";

  // Try to load card for company branding
  const cardPath = await findCard(companyId);
  if (cardPath) {
    try {
      const card = JSON.parse(await fs.readFile(cardPath, "utf8"));
      companyName = card?.identity?.name ?? card?.name?.value ?? companyName;
      tagline = card?.identity?.tagline ?? card?.tagline ?? tagline;
    } catch {
      // fall through to defaults
    }
  }

  const html = buildCallPageHtml({
    companyId,
    companyName,
    tagline,
    agentName: "Helix AI",
  });

  return reply
    .code(200)
    .header("Content-Type", "text/html; charset=utf-8")
    .send(html);
});

// POST /call-session/:companyId — public stub: create a demo agent session for the call page
app.post("/call-session/:companyId", async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  if (!companyId) return reply.code(400).send({ ok: false, error: "companyId required" });

  // Real implementation would create a playground session without auth.
  // For now, return a demo session ID so the call page UX works end-to-end.
  const sessionId = `call-${companyId}-${Date.now()}`;
  return reply.code(200).send({ ok: true, sessionId });
});

// POST /call-message/:companyId — public stub: send a message in a call session
app.post("/call-message/:companyId", async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const body = (req.body ?? {}) as { sessionId?: string; message?: string };
  if (!body.message) return reply.code(400).send({ ok: false, error: "message required" });

  const cardPath = await findCard(companyId);
  let agentContext = `You are a helpful AI assistant for a business. Be friendly, concise, and helpful.`;
  if (cardPath) {
    try {
      const card = JSON.parse(await fs.readFile(cardPath, "utf8"));
      const name = card?.identity?.name ?? "this business";
      const pitch = card?.identity?.elevatorPitch ?? "";
      agentContext = `You are Helix AI, the virtual assistant for ${name}. ${pitch} Be friendly, helpful, and concise. Answer questions about the business and help customers.`;
    } catch { /* use default */ }
  }

  try {
    const res = await aiGateway.call({
      prompt: body.message,
      systemPrompt: agentContext,
      jsonMode: false,
      temperature: 0.7,
      maxTokens: 300,
      orgId: companyId,
      operationType: "call_message",
    });
    return reply.code(200).send({ ok: true, reply: res.text.trim() });
  } catch {
    return reply.code(200).send({ ok: true, reply: "I'm here to help! Could you please repeat that?" });
  }
});

// POST /api/contact/:companyId — public stub: receive contact form submissions
app.post("/contact/:companyId", async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const body = (req.body ?? {}) as { name?: string; email?: string; phone?: string; message?: string };
  app.log.info({ contact: { companyId, name: body.name, email: body.email } }, "contact form submission");
  // Future: store or email the submission
  return reply.code(200).send({ ok: true, message: "Thank you! We'll be in touch soon." });
});

