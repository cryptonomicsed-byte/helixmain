#!/usr/bin/env python3
"""Fold a compiled CARD.md's hash + acting_hash back into card.json.

The compiler writes both hashes into CARD.md's frontmatter and emits the artifact
set, but it does NOT write them back into card.json. Any consumer that reads
card.json for the hash — notably the SparkGatekeeper shim, whose SPARK_CARD is
.../card.json — then sees no acting_hash (the shim reports acting_hash=(none)).
helix-onboard.sh's compile_card() does this fold; a direct `cli.js --card` run
does not, so the caller must.

Usage: fold-card-hashes.py /etc/helix/companies/<id>
"""
import json, re, sys

d = sys.argv[1].rstrip("/")
md = open(f"{d}/CARD.md").read()


def fm(key: str) -> str:
    m = re.search(rf"^{key}:\s*(?:sha256:)?([0-9a-f]{{64}})\s*$", md, re.M)
    return m.group(1) if m else ""


card = json.load(open(f"{d}/card.json"))
card["hash"] = fm("hash")
card["acting_hash"] = fm("acting_hash")
json.dump(card, open(f"{d}/card.json", "w"), indent=2)
print(f"folded: hash={card['hash'][:16]}... acting_hash={card['acting_hash'][:16]}...")
