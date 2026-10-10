# Card Format Compatibility

A card is labelled by its `format` key. In `CARD.md` that key lives in the YAML
frontmatter; the compiled machine view (`card.json`) does **not** carry it. The
canonical spec is the [`card-protocol`](https://github.com/cryptonomicsed-byte/card-protocol)
repo, vendored here as a git submodule at `vendor/card-protocol`.

## The table

| `format` | Emits | Reads | Status |
|---|---|---|---|
| `business-card/0.1` | helixmain `dna-foundry/compiler` | helixmain compiler, agent-voice | **current — production** |
| `business-card/0.2` | upstream `card-protocol` (`implementations/typescript`) | upstream `card-protocol` only (accepts 0.1 **and** 0.2) | known upstream (Tier Annex); helixmain has **not** adopted it — decision A |
| anything else | — | — | **rejected** |

## Who enforces what

- **helixmain compiler** — `dna-foundry/compiler/src/card-md-parse.ts`
  emits `format: business-card/0.1` and rejects any other format at parse time.
- **agent-voice** — `src/agent_voice/__main__.py::validate_card_format`
  - format **present and unsupported** → `ValueError`, refuses to load (fail closed)
  - format **absent** (the `card.json` case) → loud `WARNING`, loads anyway
- **upstream `card-protocol`** accepts both `0.1` and `0.2`. That is the
  divergence: upstream moved to `0.2` (Tier Annex) while helixmain stays `0.1`.

## Why 0.1 (decision A)

helixmain emits `0.1` until `0.2` is implemented end-to-end. Onboarding
previously wrote `0.2`, which the helixmain compiler hard-rejects — two
"compilers" that could not read each other's output. Owner decision: onboard
emits `0.1`; the `0.2` Tier Annex stays an upstream draft.

## The `format`-absent gap

Because the compiler never writes `format` into `card.json`, the production
voice path (which loads `card.json`) cannot be validated by the format string
alone — the check degrades to a logged warning there. To close the gap fully,
the compiler would need to write `format` into `card.json` *without* including
it in `cardHash` (so no existing card's hash changes). Until then, format
validation is authoritative on the `CARD.md` path and advisory on the `json` path.

## Pinned upstream

- repo: `https://github.com/cryptonomicsed-byte/card-protocol`
- commit: `c9f2b0349657514381139cbcbbac65387d3181a6` — *spec: Operations carries response_sla + pipeline_stages*

To move the pin:

```
git -C vendor/card-protocol fetch origin
git -C vendor/card-protocol checkout <sha>
git add vendor/card-protocol
git commit -m "vendor: bump card-protocol to <sha>"
```

Then re-check that this table and agent-voice's `CARD_FORMAT_*` constants still
agree with the new `spec/business-card-spec.md`.
