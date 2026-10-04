# OpenShell Spike Report
## Card: dna_c1640d90 (Santino's Pizza) · VPS 2.25.70.156

**Status:** PENDING — blocked on Docker confirmation (see VPS_RUNBOOK.md §Blocker)  
**Date:** —  
**Run by:** —

---

## Pre-flight

| Check | Result | Notes |
|-------|--------|-------|
| Docker available | PENDING | Need `docker info` from `agents` user |
| Kernel version | PENDING | `uname -r` |
| gVisor (runsc) | PENDING | `which runsc` |
| OpenShell LSM | PENDING | `open-shell status` |
| Landlock (≥ 5.13) | PENDING | from kernel version |

---

## Measurements

### §E — Idle RAM
```
ZeroClaw VmRSS:    ___ MB   (target ≤ 5 MB)
PocketBase MEM:    ___ MB
HoldQueue MEM:     ___ MB
Full stack total:  ___ MB   (target ≤ 80 MB)
```

### §F — Egress enforcement
```
Allowed (hold-queue health):   HTTP ___   (target: 200)
Blocked (8.8.8.8:80):          ___        (target: EPERM)
Blocked (exfil.attacker.com):  ___        (target: EPERM)
tcpdump SYN to blocked dest:   ___        (target: 0 packets)
```

### §G — Startup latency
```
With gVisor (runsc):  ___ ms   (target: < 10,000 ms)
Without gVisor (runc): ___ ms  (ZeroClaw-only target: < 10 ms)
```

---

## §H — 18-card extrapolation

| Metric | 1 card | 18 cards | VPS headroom |
|--------|--------|----------|--------------|
| ZeroClaw RSS | ___ MB | ___ MB | 1 GB |
| Full stack (shared PB) | ___ MB | ___ MB | |
| Egress EPERM | — | all must pass | |

---

## Exit criteria

| # | Check | Pass? |
|---|-------|-------|
| 1 | Docker available | — |
| 2 | Kernel ≥ 5.13 | — |
| 3 | OpenShell LSM active | — |
| 4 | ZeroClaw boots < 10s | — |
| 5 | ZeroClaw idle ≤ 5 MB | — |
| 6 | Egress EPERM on blocked dest | — |
| 7 | No SYN to blocked dest | — |
| 8 | 18-card projection ≤ 700 MB | — |

---

## Decision

_After all 8 checks:_ **PROCEED to Phase 2 / REVISE approach**  

Rationale: _fill in after run_
