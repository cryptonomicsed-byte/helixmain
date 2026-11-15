#!/usr/bin/env python3
"""Check deploy/prometheus/helix-alerts.yml.

  * the file is valid YAML with the expected shape
  * every alert has a name, expr, severity and summary, and alert names are unique
  * every helix_* metric an expression mentions is defined by a source file of this repository
    (so a renamed metric cannot silently leave an alert watching nothing)
"""
import os, re, sys
import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
rules = yaml.safe_load(open(os.path.join(HERE, "prometheus", "helix-alerts.yml")))

known = set()
for base in ("gateway", "orchestrator/lib"):
    for d, _, names in os.walk(os.path.join(ROOT, base)):
        if "/gen/" in d or "node_modules" in d or "/_build" in d:
            continue
        for n in names:
            if n.endswith((".go", ".ex")) and not n.endswith("_test.go"):
                text = open(os.path.join(d, n), encoding="utf-8").read()
                known |= set(re.findall(r'"(helix_[a-z_]+)"', text)) | set(re.findall(r"\b(helix_[a-z_]+)\b", text))

problems, names = [], set()
for g in rules["groups"]:
    for r in g["rules"]:
        a = r.get("alert", "?")
        if a in names: problems.append(f"{a}: duplicate alert name")
        names.add(a)
        for k in ("expr", "labels", "annotations"):
            if not r.get(k): problems.append(f"{a}: missing {k}")
        if r.get("labels", {}).get("severity") not in ("page", "ticket"): problems.append(f"{a}: severity must be page or ticket")
        if not r.get("annotations", {}).get("summary"): problems.append(f"{a}: missing a summary")
        for m in re.findall(r"\b(helix_[a-z_]+?)(?:_bucket|_sum|_count)?\b(?=[\s{\[)]|$)", r.get("expr", "")):
            base = re.sub(r"_(bucket|sum|count)$", "", m)
            if m not in known and base not in known:
                problems.append(f"{a}: the expression uses {m}, which no source file exports")
if problems:
    print("\n".join(problems), file=sys.stderr)
    sys.exit(1)
print(f"{len(names)} alerts in {len(rules['groups'])} groups; every metric they use is exported")
