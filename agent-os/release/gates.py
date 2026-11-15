#!/usr/bin/env python3
"""The HELIX release gates, in one command.

    python3 release/gates.py                 run every gate
    python3 release/gates.py --only kernel,gateway
    python3 release/gates.py --skip deploy-drill
    python3 release/gates.py --require-all   a SKIPPED gate counts as a failure (use this before a release)
    python3 release/gates.py --list

Each gate is a command with a timeout. Outcomes: PASS, FAIL, SKIPPED (a prerequisite is missing, and the
reason is printed: a skip is never silent). Evidence (commit, toolchains, every result with its timing and
the tail of its output) is written to release/evidence-<commit>.json. Exit status is non-zero if any gate
failed (or was skipped under --require-all).
"""
import argparse, json, os, shutil, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                                   # agent-os
REPO = subprocess.check_output(["git", "-C", ROOT, "rev-parse", "--show-toplevel"], text=True).strip()
SIBLINGS = os.environ.get("HELIX_REPOS", os.path.dirname(REPO))  # where sid, card-protocol ... are checked out

def have(*tools):
    return [t for t in tools if shutil.which(t) is None]

def gate(name, cwd, cmd, needs=(), timeout=900, why=""):
    return dict(name=name, cwd=cwd, cmd=cmd, needs=needs, timeout=timeout, why=why)

GATES = [
    gate("secrets", ROOT, ["python3", "release/scan_secrets.py"], ["python3", "git"], 120, "no key, token or API key is committed"),
    gate("contracts", ROOT, ["python3", "contracts/conformance/generate_canonical.py", "--check"], ["python3"], 120,
         "the canonical JSON golden vectors are reproducible"),
    gate("policy", f"{ROOT}/policy", ["./run-tests.sh"], ["java", "curl"], 900, "the Clojure policy service"),
    gate("kernel", f"{ROOT}/kernel", ["cargo", "test", "--locked"], ["cargo"], 1800, "the Rust kernel and its Wasm plugin host"),
    gate("kernel-with-policy", f"{ROOT}/kernel", ["cargo", "test", "--test", "policy_clojure", "--", "--ignored", "--test-threads=1"], ["cargo", "java"], 900,
         "the kernel against the real Clojure policy service"),
    gate("plugins", f"{ROOT}/plugins", ["./test.sh"], ["cargo", "rustup"], 1800, "rebuild the plugin components, then run the host against them"),
    gate("gateway", f"{ROOT}/gateway", ["./test.sh"], ["go", "cargo", "java", "git"], 1800,
         "generated code is current; unit tests with the race detector; gateway -> kernel -> policy end to end; mutual TLS"),
    gate("orchestrator", f"{ROOT}/orchestrator", ["./test.sh"], ["mix", "go", "cargo", "java"], 1800, "format, warnings, unit tests, and end to end against the real stack"),
    gate("alerts", f"{ROOT}/deploy", ["./check-alerts.py"], ["python3"], 60, "every alert names a metric that is exported"),
    gate("systemd-units", f"{ROOT}/deploy", ["./check-units.sh"], ["systemd-analyze"], 60, "the unit files are valid (only the not-yet-installed binaries are tolerated)"),
    gate("deploy-drill", f"{ROOT}/deploy", ["./selftest.sh"], ["go", "cargo", "java", "curl", "python3"], 1200,
         "bootstrap, start, smoke, real work, backup, destroy the database, restore, prove nothing was lost, refuse a tampered backup"),
    gate("go-vulnerabilities", f"{ROOT}/gateway", ["bash", "-c", "govulncheck ./..."], ["govulncheck"], 300, "known vulnerabilities in the Go dependencies"),
    gate("sid-vectors", f"{SIBLINGS}/sid", ["bash", "-c", "python3 conformance/run_vectors_02.py && python3 conformance/run_vectors_qr.py"], ["python3"], 300,
         "sid/0.2 (54) and helix-qr/1 (111) conformance vectors in the Python reference"),
    gate("sid-typescript", f"{SIBLINGS}/sid/implementations/typescript", ["npm", "test"], ["npm"], 600, "the TypeScript sid/0.2 and helix-qr/1 implementations agree"),
]

def run(g):
    missing = have(*g["needs"])
    if missing:
        return "SKIPPED", 0.0, f"needs {', '.join(missing)} on PATH"
    if not os.path.isdir(g["cwd"]):
        return "SKIPPED", 0.0, f"{g['cwd']} is not present"
    t = time.time()
    try:
        p = subprocess.run(g["cmd"], cwd=g["cwd"], capture_output=True, text=True, timeout=g["timeout"])
    except subprocess.TimeoutExpired:
        return "FAIL", time.time() - t, f"timed out after {g['timeout']} s"
    out = (p.stdout + p.stderr).strip().splitlines()
    tail = "\n".join(out[-12:])
    if g["name"] == "go-vulnerabilities" and p.returncode != 0 and ("Forbidden" in tail or "fetching vulnerabilities" in tail):
        return "SKIPPED", time.time() - t, "the vulnerability database (vuln.go.dev) is not reachable from here"
    return ("PASS" if p.returncode == 0 else "FAIL"), time.time() - t, tail

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only"); ap.add_argument("--skip"); ap.add_argument("--require-all", action="store_true"); ap.add_argument("--list", action="store_true")
    a = ap.parse_args()
    if a.list:
        for g in GATES: print(f"{g['name']:20} {g['why']}")
        return 0
    only = set(a.only.split(",")) if a.only else None
    skip = set(a.skip.split(",")) if a.skip else set()
    unknown = (only or set()) | skip
    unknown -= {g["name"] for g in GATES}
    if unknown: sys.exit(f"unknown gate(s): {', '.join(sorted(unknown))}")

    commit = subprocess.check_output(["git", "-C", REPO, "rev-parse", "HEAD"], text=True).strip()
    dirty = bool(subprocess.check_output(["git", "-C", REPO, "status", "--porcelain"], text=True).strip())
    results = []
    for g in GATES:
        if (only and g["name"] not in only) or g["name"] in skip:
            continue
        print(f"--> {g['name']}: {g['why']}", flush=True)
        status, secs, detail = run(g)
        print(f"    {status} ({secs:.0f} s){'  ' + detail.splitlines()[-1] if status != 'PASS' and detail else ''}", flush=True)
        results.append(dict(name=g["name"], status=status, seconds=round(secs, 1), command=" ".join(g["cmd"]), detail=detail))

    def version(cmd):
        try: return subprocess.run(cmd, capture_output=True, text=True, timeout=20).stdout.strip().splitlines()[0]
        except Exception: return None
    evidence = dict(
        commit=commit, uncommitted_changes=dirty, generated_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        toolchains={"rustc": version(["rustc", "--version"]), "go": version(["go", "version"]), "java": version(["java", "-version"]) or None,
                    "elixir": version(["elixir", "--version"]), "python": sys.version.split()[0]},
        results=results,
    )
    out = os.path.join(HERE, f"evidence-{commit[:12]}.json")
    json.dump(evidence, open(out, "w"), indent=1)

    print("\n" + "=" * 70)
    for r in results: print(f"{r['status']:8} {r['name']:20} {r['seconds']:7.1f} s")
    passed = sum(r["status"] == "PASS" for r in results); failed = sum(r["status"] == "FAIL" for r in results); skipped = sum(r["status"] == "SKIPPED" for r in results)
    print(f"{passed} passed, {failed} failed, {skipped} skipped   (evidence: {os.path.relpath(out, REPO)}{', with uncommitted changes' if dirty else ''})")
    if skipped: print("SKIPPED gates did not run. They are not passes.")
    return 1 if failed or (a.require_all and skipped) else 0

if __name__ == "__main__":
    sys.exit(main())
