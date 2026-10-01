# sonic-brand

Give a business its sound. This skill patches the **Sound** section of a
`CARD.md` — and nothing else on the card.

## Authority

- Read: `Identity` (name) and `Voice` (tone). **Stop if `Identity.name`
  or `Voice.tone` is missing** — do not invent a sound for a business you
  cannot name or characterize.
- Write: the Sound section only (`voice.sonic`: `voice_logo`, `sonic_logo`,
  `ui_sounds`). Never touch Identity, Offer, Operations, Policy, Handoff,
  Knowledge, or the Appendix.
- Do not invent offer, price, or policy. Sound is derived from who the
  business *is*, never from what it sells.

## Assets

| Asset | Constraint | State |
|---|---|---|
| `sonic_logo` | under **4 seconds**. A short musical mark (cf. Windows login tone, PlayStation boot sound, Netflix intro). | staged until a music-model key exists (`FAL_API_KEY`); the brief is written and the prompt staged |
| `voice_logo` | under **6 seconds**. A spoken line in the business's voice. | rendered via TTS; stored content-addressed as `assets/<sha256>.mp3` |
| `ui_sounds` | notification, success, and quiet rounded error tones | staged; briefs only until rendered |

State rule: an asset with an `asset_ref` is `ready`; a brief with no asset
is `staged`. A voice agent may play only `ready` assets. States are derived
from the card — never set by hand.

## Flow

1. Read the card JSON for Identity and Voice. Build the brief
   (`brief.py`): voice type, music genre, sound keywords from tone.
2. Render what the providers allow (`assets.py`):
   - voice logo: TTS of the voice-logo line, ≤ 6s, MP3, content-addressed.
   - sonic logo / UI tones: staged briefs + generation prompts until
     `FAL_API_KEY` is configured.
3. Assemble a Sound-shaped patch and hand it to the compiler, which
   enforces the Sound-only restriction, bumps the version, chains
   `previous_hash`, appends a changelog entry, and re-emits `CARD.md`:
   ```
   node compiler/dist/cli.js --patch-sound --md <CARD.md> \
     --patch <sound-patch.json>
   ```
   The patch may contain only `voice_logo`, `sonic_logo`, `ui_sounds`,
   `provenance`, and `changelog`. Anything else is ignored.
4. Parse the new `CARD.md` back to JSON so the machine view stays in sync
   with the product.

The CLI (`cli.py`) does all of this:
```
python3 swarm/skills/sonic_brand/cli.py --card <card.json> --md <CARD.md> \
  --assets-dir <assets> [--only voice_logo,sonic_logo,ui_sounds] \
  [--voice-profile <profile>]
```

## Draft semantics

If the card is `draft`, briefs may be written — but owner-confirmation
semantics stay explicit. Rendering audio does not confirm anything; a
`ready` asset on a `draft` card is still draft.

## Changelog

Every invocation appends a `sonic-brand` changelog entry naming what was
rendered and what stayed staged.
