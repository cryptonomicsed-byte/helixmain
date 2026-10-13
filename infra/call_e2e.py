"""End-to-end proof that /call/<slug> is a real voice call.

Headless Chromium acts as the caller with a fake microphone fed from a real
WAV, so the whole chain runs: browser mic -> WebRTC -> agent-voice endpoint ->
Whisper STT -> card-grounded LLM -> Piper TTS -> WebRTC -> browser.

The assertion that matters is the orb's class. It only reaches 'orb speaking'
when a live AnalyserNode sees real energy on the *remote* stream — i.e. audio
produced by the agent actually arrived in the browser. A simulation cannot
make that happen.

Run on the VPS:  /opt/venv/bin/python3 infra/call_e2e.py [URL] [SECONDS] [SHOT]
Needs playwright in that venv, and /root/fake-mic.wav (the WAV the fake mic
replays as caller audio).
"""
import sys
import time

from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "https://helixmain.duckdns.org/call/demo-barber"
SECONDS = float(sys.argv[2]) if len(sys.argv) > 2 else 60
SHOT = sys.argv[3] if len(sys.argv) > 3 else "/root/call-test.png"

READ = """() => {
  const orb = document.getElementById('orb');
  const audio = document.getElementById('remoteAudio');
  return {
    orb: orb ? orb.className : '',
    status: (document.getElementById('statusText') || {}).textContent || '',
    log: Array.from(document.querySelectorAll('#transcript .msg')).map(d => d.textContent),
    remoteAudio: !!(audio && audio.srcObject),
    bars: Array.from(document.querySelectorAll('.bar')).map(b => b.style.height)
  };
}"""

seen = {"speaking": False, "connected": False, "remoteAudio": False}

with sync_playwright() as p:
    browser = p.chromium.launch(args=[
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--use-file-for-fake-audio-capture=/root/fake-mic.wav",
        "--autoplay-policy=no-user-gesture-required",
        "--no-sandbox",
    ])
    ctx = browser.new_context(permissions=["microphone"],
                              viewport={"width": 420, "height": 900})
    page = ctx.new_page()
    page.on("console", lambda m: print(f"    [console:{m.type}] {m.text[:180]}"))
    page.on("pageerror", lambda e: print(f"    [PAGEERROR] {str(e)[:300]}"))

    print(f"==> navigating {URL}")
    page.goto(URL, wait_until="load", timeout=45_000)
    print(f"    title: {page.title()}")
    start_btn_visible = page.is_visible("#btnStart")
    print(f"    start button visible: {start_btn_visible}  (must be False)")
    # The orb page AUTO-STARTS on entry -- entering IS the intent to call, so there
    # is nothing to click. The Start control is hidden (class 'hidden' in the markup,
    # plus visibility:hidden and opacity:0 from CSS) and it must STAY hidden: a
    # visible Start button on an auto-start page is a dead control. Asserted below.
    print("==> auto-start: ringing on entry (not clicking)")

    t0 = time.time()
    last_log = []
    while time.time() - t0 < SECONDS:
        time.sleep(2.5)
        try:
            st = page.evaluate(READ)
        except Exception as e:
            print(f"    [eval failed] {e}")
            break
        el = time.time() - t0
        cls = st["orb"].replace("orb ", "")
        print(f"    t={el:5.1f}s  orb={cls:<12} remoteAudio={st['remoteAudio']}  status={st['status']!r}")
        if "speaking" in st["orb"]:
            seen["speaking"] = True
        if "listening" in st["orb"]:
            seen["connected"] = True
        if st["remoteAudio"]:
            seen["remoteAudio"] = True
        for line in st["log"]:
            if line not in last_log:
                print(f"        log> {line}")

    page.screenshot(path=SHOT, full_page=True)
    print(f"==> screenshot: {SHOT}")
    browser.close()

print("\n==> RESULT")
print(f"    remote audio element bound : {seen['remoteAudio']}")
print(f"    reached 'listening'        : {seen['connected']}")
print(f"    reached 'speaking' (agent audio arrived): {seen['speaking']}")
print(f"    Start button hidden        : {not start_btn_visible}")
sys.exit(0 if (seen["connected"] and seen["speaking"] and not start_btn_visible) else 1)
