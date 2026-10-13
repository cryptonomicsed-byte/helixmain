/**
 * contentPipeline — Sacred Core campaign PRD + autonomous asset engine.
 *
 * All publish/send/post actions are H-gated through SparkGatekeeper:
 *   submitForApproval() POSTs to localhost:9100/hold and returns a holdQueueId.
 *   The asset is NEVER published without owner approval in the hold queue.
 */

import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { aiGateway } from "./aiGateway";
import { validateContent } from "./brandVoiceValidator";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AssetStatus = "draft" | "healing" | "approved" | "published";
export type AssetType = "post" | "email" | "ad" | "blog" | "caption" | "video_script";
export type Channel = "instagram" | "facebook" | "x" | "linkedin" | "email" | "sms" | "tiktok";

export interface CampaignPRD {
  id: string;
  companyId: string;
  goal: string;
  channels: Channel[];
  overview: string;
  channelStrategies: Record<Channel, { objective: string; tone: string; frequency: string }>;
  userStories: UserStory[];
  sequencingPlan: string;
  createdAt: string;
}

export interface UserStory {
  id: string;
  channel: Channel;
  assetType: AssetType;
  brief: string;
  audiencePersona?: string;
}

export interface CampaignAsset {
  id: string;
  campaignId: string;
  storyId: string;
  channel: Channel;
  assetType: AssetType;
  text: string;
  hashtags: string[];
  mediaDescription: string;
  qualityScore: number;       // 0-100
  status: AssetStatus;
  voiceValidation?: { passed: boolean; violations: string[] };
  holdQueueId?: string;       // set when submitted to SparkGatekeeper
  audioSuggestion?: string;   // TikTok: trending sound description
  emailMetadata?: { subject: string; preheader: string; cta: string };
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// In-memory stores (keyed by id)
// ---------------------------------------------------------------------------

export const prdStore      = new Map<string, CampaignPRD>();
export const assetStore    = new Map<string, CampaignAsset>();
export const scheduleStore = new Map<string, ScheduledAsset>();

// ---------------------------------------------------------------------------
// Scheduling types
// ---------------------------------------------------------------------------

export interface ScheduledAsset {
  assetId: string;
  companyId: string;
  publishAt: string;    // ISO8601
  scheduledAt: string;  // ISO8601
}

// ---------------------------------------------------------------------------
// Disk persistence
// ---------------------------------------------------------------------------

const PRD_PATH      = process.env.HELIX_PRD_PATH      ?? "/etc/helix/data/prds.json";
const ASSETS_PATH   = process.env.HELIX_ASSETS_PATH   ?? "/etc/helix/data/assets.json";
const SCHEDULE_PATH = process.env.HELIX_SCHEDULE_PATH ?? "/etc/helix/data/schedule.json";

export async function loadContentStores(): Promise<void> {
  try {
    const rawPrds = await fs.readFile(PRD_PATH, "utf8");
    const prds = JSON.parse(rawPrds) as Array<[string, CampaignPRD]>;
    for (const [id, prd] of prds) prdStore.set(id, prd);
  } catch {
    // file may not exist on first run — silently skip
  }
  try {
    const rawAssets = await fs.readFile(ASSETS_PATH, "utf8");
    const assets = JSON.parse(rawAssets) as Array<[string, CampaignAsset]>;
    for (const [id, asset] of assets) assetStore.set(id, asset);
  } catch {
    // file may not exist on first run — silently skip
  }
  try {
    const rawSchedule = await fs.readFile(SCHEDULE_PATH, "utf8");
    const schedule = JSON.parse(rawSchedule) as Array<[string, ScheduledAsset]>;
    for (const [id, entry] of schedule) scheduleStore.set(id, entry);
  } catch {
    // file may not exist on first run — silently skip
  }
}

async function saveContentStores(): Promise<void> {
  try {
    const dir = path.dirname(PRD_PATH);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(PRD_PATH, JSON.stringify(Array.from(prdStore.entries()), null, 2));
  } catch {
    // never throw to caller
  }
  try {
    const dir = path.dirname(ASSETS_PATH);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(ASSETS_PATH, JSON.stringify(Array.from(assetStore.entries()), null, 2));
  } catch {
    // never throw to caller
  }
  try {
    const dir = path.dirname(SCHEDULE_PATH);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(SCHEDULE_PATH, JSON.stringify(Array.from(scheduleStore.entries()), null, 2));
  } catch {
    // never throw to caller
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function now(): string {
  return new Date().toISOString();
}

function cardName(card: any): string {
  return card?.identity?.name ?? card?.name?.value ?? "the business";
}

function cardTagline(card: any): string {
  return card?.identity?.tagline ?? card?.tagline ?? "";
}

function cardOfferings(card: any): string {
  const offerings: any[] = card?.offerings ?? [];
  if (!offerings.length) return "our offerings";
  return offerings.map((o: any) => o.name ?? o).join(", ");
}

function cardTone(card: any): string {
  const tone = card?.voice?.tone;
  if (Array.isArray(tone)) return tone.join(", ");
  return String(tone ?? "professional");
}

function cardPersonality(card: any): string {
  return card?.voice?.personality ?? card?.voice?.description ?? "";
}

// ---------------------------------------------------------------------------
// generateCampaignPRD
// ---------------------------------------------------------------------------

/**
 * Generate a full campaign PRD from a card and goal.
 * Returns a structured CampaignPRD with channelStrategies and userStories.
 */
export async function generateCampaignPRD(
  card: any,
  goal: string,
  channels: Channel[],
): Promise<CampaignPRD> {
  const name        = cardName(card);
  const tagline     = cardTagline(card);
  const offerings   = cardOfferings(card);
  const tone        = cardTone(card);
  const personality = cardPersonality(card);
  const companyId: string = card?.org_id ?? card?.id ?? "unknown";

  const prompt = `You are a marketing strategist. A local business wants to run a campaign.
Business: ${name}
Tagline: ${tagline}
Offerings: ${offerings}
Voice: ${tone}${personality ? ` — ${personality}` : ""}
Goal: ${goal}
Channels: ${channels.join(", ")}

Return a campaign PRD as JSON with exactly these keys:
{
  "overview": "string — 2-3 sentence campaign summary",
  "channelStrategies": {
    "<channel>": { "objective": "string", "tone": "string", "frequency": "string" }
  },
  "userStories": [
    {
      "channel": "<channel>",
      "assetType": "post|email|ad|blog|caption|video_script",
      "brief": "string — what this piece should accomplish",
      "audiencePersona": "string — optional target persona"
    }
  ],
  "sequencingPlan": "string — week-by-week rollout"
}

Include channelStrategies for every channel listed. Include 2-3 userStories per channel.`;

  const res = await aiGateway.call({
    prompt,
    systemPrompt: "You are a marketing strategist. Return valid JSON only.",
    jsonMode: true,
    temperature: 0.7,
    maxTokens: 3000,
    orgId: companyId,
    operationType: "campaign_prd",
  });

  let raw: any;
  try {
    raw = JSON.parse(res.text);
  } catch {
    raw = {};
  }

  // Normalise userStories — add ids, validate channel/assetType
  const validChannels = new Set<string>(channels);
  const validAssetTypes = new Set<string>(["post", "email", "ad", "blog", "caption", "video_script"]);

  const rawStories: any[] = Array.isArray(raw.userStories) ? raw.userStories : [];
  const userStories: UserStory[] = rawStories
    .filter((s) => validChannels.has(s.channel) && validAssetTypes.has(s.assetType))
    .map((s) => ({
      id:              randomUUID(),
      channel:         s.channel as Channel,
      assetType:       s.assetType as AssetType,
      brief:           String(s.brief ?? ""),
      audiencePersona: s.audiencePersona ? String(s.audiencePersona) : undefined,
    }));

  // Build channel strategies — fill missing channels with defaults
  const rawStrategies: Record<string, any> = raw.channelStrategies ?? {};
  const channelStrategies: Record<Channel, { objective: string; tone: string; frequency: string }> =
    {} as Record<Channel, { objective: string; tone: string; frequency: string }>;

  for (const ch of channels) {
    const s = rawStrategies[ch] ?? {};
    channelStrategies[ch] = {
      objective: String(s.objective ?? `Drive ${goal} via ${ch}`),
      tone:      String(s.tone      ?? tone),
      frequency: String(s.frequency ?? "3x per week"),
    };
  }

  const prd: CampaignPRD = {
    id:               randomUUID(),
    companyId,
    goal,
    channels,
    overview:         String(raw.overview ?? ""),
    channelStrategies,
    userStories,
    sequencingPlan:   String(raw.sequencingPlan ?? ""),
    createdAt:        now(),
  };

  prdStore.set(prd.id, prd);
  saveContentStores().catch(() => {});
  return prd;
}

// ---------------------------------------------------------------------------
// generateCampaignAssets
// ---------------------------------------------------------------------------

/**
 * Generate a CampaignAsset for every UserStory in a PRD.
 * Each asset is validated for brand voice after generation.
 * Assets with qualityScore < 60 are automatically healed once.
 */
export async function generateCampaignAssets(
  prd: CampaignPRD,
  card: any,
): Promise<CampaignAsset[]> {
  const name        = cardName(card);
  const tone        = cardTone(card);
  const personality = cardPersonality(card);

  const assets: CampaignAsset[] = [];

  for (const story of prd.userStories) {
    let prompt: string;

    if (story.channel === "tiktok") {
      prompt = `Write a TikTok video script for ${name}.
Voice: ${tone}${personality ? `, ${personality}` : ""}
Brief: ${story.brief}${story.audiencePersona ? `\nAudience: ${story.audiencePersona}` : ""}

Return JSON only:
{
  "text": "the on-screen text / caption for the TikTok",
  "hashtags": ["array", "of", "trending", "hashtags"],
  "mediaDescription": "description of what should happen on screen (visuals, actions, transitions)",
  "audioSuggestion": "description of a trending sound or music style that fits this content"
}`;
    } else if (story.channel === "linkedin" && story.assetType === "post") {
      prompt = `Write a LinkedIn post for ${name}.
Voice: ${tone}${personality ? `, ${personality}` : ""}
Brief: ${story.brief}${story.audiencePersona ? `\nAudience: ${story.audiencePersona}` : ""}

Return JSON only:
{
  "headline": "attention-grabbing opening line",
  "hook": "second paragraph that deepens interest",
  "body": "main value proposition or story (2-3 paragraphs)",
  "cta": "clear call-to-action closing line",
  "hashtags": ["array", "of", "professional", "hashtags"],
  "mediaDescription": "description of accompanying image or document for the creative team"
}`;
    } else if (story.assetType === "email") {
      prompt = `Write a marketing email for ${name}.
Voice: ${tone}${personality ? `, ${personality}` : ""}
Brief: ${story.brief}${story.audiencePersona ? `\nAudience: ${story.audiencePersona}` : ""}

Return JSON only:
{
  "subject": "email subject line",
  "preheader": "preview text shown in inbox (max 90 chars)",
  "bodyHtml": "full HTML email body with inline styles, professional layout",
  "cta": "call-to-action button text"
}`;
    } else {
      prompt = `Write a ${story.assetType} for ${story.channel} for ${name}.
Voice: ${tone}${personality ? `, ${personality}` : ""}
Brief: ${story.brief}${story.audiencePersona ? `\nAudience: ${story.audiencePersona}` : ""}

Return JSON only:
{
  "text": "the full content of the post/email/ad/etc",
  "hashtags": ["array", "of", "relevant", "hashtags"],
  "mediaDescription": "description of accompanying image or video for the creative team"
}`;
    }

    const res = await aiGateway.call({
      prompt,
      systemPrompt: "You are a social media copywriter. Return valid JSON only.",
      jsonMode: true,
      temperature: 0.8,
      orgId: prd.companyId,
      operationType: "campaign_asset",
    });

    let raw: any;
    try {
      raw = JSON.parse(res.text);
    } catch {
      raw = {};
    }

    // Build text field and channel-specific extras
    let assetText: string;
    let assetHashtags: string[];
    let audioSuggestion: string | undefined;
    let emailMetadata: { subject: string; preheader: string; cta: string } | undefined;

    if (story.channel === "tiktok") {
      assetText        = String(raw.text ?? "");
      assetHashtags    = Array.isArray(raw.hashtags) ? raw.hashtags.map(String) : [];
      audioSuggestion  = raw.audioSuggestion ? String(raw.audioSuggestion) : undefined;
    } else if (story.channel === "linkedin" && story.assetType === "post") {
      const headline = String(raw.headline ?? "");
      const hook     = String(raw.hook ?? "");
      const body     = String(raw.body ?? "");
      const cta      = String(raw.cta ?? "");
      assetText     = [headline, hook, body, cta].filter(Boolean).join("\n\n");
      assetHashtags = Array.isArray(raw.hashtags) ? raw.hashtags.map(String) : [];
    } else if (story.assetType === "email") {
      // Store full email structure as JSON string in text; no public hashtags
      assetText     = JSON.stringify({
        subject:   raw.subject   ?? "",
        preheader: raw.preheader ?? "",
        bodyHtml:  raw.bodyHtml  ?? "",
        cta:       raw.cta       ?? "",
      });
      assetHashtags = [];
      emailMetadata = {
        subject:   String(raw.subject   ?? ""),
        preheader: String(raw.preheader ?? ""),
        cta:       String(raw.cta       ?? ""),
      };
    } else {
      assetText     = String(raw.text ?? "");
      assetHashtags = Array.isArray(raw.hashtags) ? raw.hashtags.map(String) : [];
    }

    const asset: CampaignAsset = {
      id:               randomUUID(),
      campaignId:       prd.id,
      storyId:          story.id,
      channel:          story.channel,
      assetType:        story.assetType,
      text:             assetText,
      hashtags:         assetHashtags,
      mediaDescription: String(raw.mediaDescription ?? ""),
      qualityScore:     70,
      status:           "draft",
      ...(audioSuggestion !== undefined && { audioSuggestion }),
      ...(emailMetadata   !== undefined && { emailMetadata }),
      createdAt:        now(),
      updatedAt:        now(),
    };

    // Validate brand voice
    const validation = await validateBrandVoice(asset, card);
    asset.qualityScore  = validation.score;
    asset.voiceValidation = { passed: validation.passed, violations: validation.violations };

    // Auto-heal if quality is below threshold
    const healed =
      !validation.passed || asset.qualityScore < 60
        ? await healAsset(
            asset,
            card,
            validation.violations.length > 0
              ? `Violations: ${validation.violations.join("; ")}`
              : "Low quality score — please improve.",
          )
        : asset;

    assetStore.set(healed.id, healed);
    saveContentStores().catch(() => {});
    assets.push(healed);
  }

  return assets;
}

// ---------------------------------------------------------------------------
// validateBrandVoice
// ---------------------------------------------------------------------------

/**
 * Validate a single CampaignAsset against the card brand voice.
 * Delegates to brandVoiceValidator and returns the same shape plus a
 * separate `score` field for convenience.
 */
export async function validateBrandVoice(
  asset: CampaignAsset,
  card: any,
): Promise<{ passed: boolean; violations: string[]; score: number }> {
  return validateContent(asset.text, card);
}

// ---------------------------------------------------------------------------
// submitForApproval  (H-gate: SparkGatekeeper)
// ---------------------------------------------------------------------------

const SPARK_GATEKEEPER_URL = "http://localhost:9100/hold";

/**
 * Submit an approved asset to SparkGatekeeper's hold queue.
 * Returns the holdQueueId assigned by SparkGatekeeper.
 *
 * IMPORTANT: If SparkGatekeeper is unreachable this function THROWS.
 * The asset must never be auto-published on gatekeeper failure.
 */
export async function submitForApproval(
  asset: CampaignAsset,
  companyId: string,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(SPARK_GATEKEEPER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        companyId,
        action: "content.publish",
        asset,
        risk: "medium",
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `SparkGatekeeper unreachable — asset NOT submitted. Original error: ${msg}`,
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `SparkGatekeeper returned HTTP ${res.status}: ${body.slice(0, 500)}`,
    );
  }

  const json = (await res.json()) as { id?: string };
  if (!json.id) {
    throw new Error(
      "SparkGatekeeper response missing 'id' — asset NOT submitted.",
    );
  }

  // Update the in-memory store so the caller can see the holdQueueId
  const stored = assetStore.get(asset.id);
  if (stored) {
    stored.holdQueueId = json.id;
    stored.status = "approved";
    stored.updatedAt = now();
    saveContentStores().catch(() => {});
  }

  return json.id;
}

// ---------------------------------------------------------------------------
// healAsset
// ---------------------------------------------------------------------------

/**
 * Regenerate an asset that scored below 60 or failed brand voice validation.
 *
 * Sets status to 'healing' during regeneration, then 'draft' on completion.
 * The returned asset has a new id so callers should replace the old reference.
 */
export async function healAsset(
  asset: CampaignAsset,
  card: any,
  feedback?: string,
): Promise<CampaignAsset> {
  const healing: CampaignAsset = {
    ...asset,
    status:    "healing",
    updatedAt: now(),
  };
  assetStore.set(healing.id, healing);
  saveContentStores().catch(() => {});

  const name        = cardName(card);
  const tone        = cardTone(card);
  const personality = cardPersonality(card);

  const feedbackBlock = feedback
    ? `\nPrevious attempt had these issues — fix them:\n${feedback}`
    : "\nThe previous attempt had a low quality score. Please improve clarity, tone alignment, and engagement.";

  const prompt = `Rewrite this ${asset.assetType} for ${asset.channel} for ${name}.
Voice: ${tone}${personality ? `, ${personality}` : ""}
Original content: "${asset.text}"
${feedbackBlock}

Return JSON only:
{
  "text": "improved content",
  "hashtags": ["array", "of", "relevant", "hashtags"],
  "mediaDescription": "description of accompanying image or video"
}`;

  const res = await aiGateway.call({
    prompt,
    systemPrompt: "You are a social media copywriter. Return valid JSON only.",
    jsonMode: true,
    temperature: 0.7,
    orgId: asset.campaignId ? prdStore.get(asset.campaignId)?.companyId : undefined,
    operationType: "campaign_asset_heal",
  });

  let raw: any;
  try {
    raw = JSON.parse(res.text);
  } catch {
    raw = {};
  }

  const validation = await validateContent(String(raw.text ?? asset.text), card);

  const healed: CampaignAsset = {
    ...asset,
    text:             String(raw.text ?? asset.text),
    hashtags:         Array.isArray(raw.hashtags) ? raw.hashtags.map(String) : asset.hashtags,
    mediaDescription: String(raw.mediaDescription ?? asset.mediaDescription),
    qualityScore:     validation.score,
    voiceValidation:  { passed: validation.passed, violations: validation.violations },
    status:           "draft",
    updatedAt:        now(),
  };

  assetStore.set(healed.id, healed);
  saveContentStores().catch(() => {});
  return healed;
}

// ---------------------------------------------------------------------------
// Social scheduling
// ---------------------------------------------------------------------------

export function scheduleAsset(
  assetId: string,
  companyId: string,
  publishAt: string,
): ScheduledAsset {
  const entry: ScheduledAsset = {
    assetId,
    companyId,
    publishAt,
    scheduledAt: now(),
  };
  // Mark asset as approved (it has been scheduled for publish)
  const asset = assetStore.get(assetId);
  if (asset) {
    asset.status    = "approved";
    asset.updatedAt = now();
    assetStore.set(assetId, asset);
  }
  scheduleStore.set(assetId, entry);
  saveContentStores().catch(() => {});
  return entry;
}

export function getScheduledAssets(companyId: string): ScheduledAsset[] {
  return Array.from(scheduleStore.values()).filter((e) => e.companyId === companyId);
}

export function cancelSchedule(assetId: string): boolean {
  if (!scheduleStore.has(assetId)) return false;
  scheduleStore.delete(assetId);
  const asset = assetStore.get(assetId);
  if (asset) {
    asset.status    = "draft";
    asset.updatedAt = now();
    assetStore.set(assetId, asset);
  }
  saveContentStores().catch(() => {});
  return true;
}

// ---------------------------------------------------------------------------
// A/B variant generation
// ---------------------------------------------------------------------------

/**
 * Generate `count` independent content variants for a single UserStory.
 * Each variant is an independent aiGateway.call() at a slightly different
 * temperature so outputs differ meaningfully.
 */
export async function generateVariants(
  prd: CampaignPRD,
  card: any,
  storyId: string,
  count = 2,
): Promise<CampaignAsset[]> {
  const story = prd.userStories.find((s) => s.id === storyId);
  if (!story) throw new Error(`UserStory not found: ${storyId}`);

  const name        = cardName(card);
  const tone        = cardTone(card);
  const personality = cardPersonality(card);

  const temperatures = [0.7, 0.85, 0.9, 0.95];

  const prompt = `Write a ${story.assetType} for ${story.channel} for ${name}.
Voice: ${tone}${personality ? `, ${personality}` : ""}
Brief: ${story.brief}${story.audiencePersona ? `\nAudience: ${story.audiencePersona}` : ""}

Return JSON only:
{
  "text": "the full content",
  "hashtags": ["array", "of", "relevant", "hashtags"],
  "mediaDescription": "description of accompanying image or video"
}`;

  const calls = Array.from({ length: count }, (_, i) =>
    aiGateway.call({
      prompt,
      systemPrompt: "You are a social media copywriter. Return valid JSON only.",
      jsonMode: true,
      temperature: temperatures[i] ?? 0.85 + i * 0.05,
      orgId: prd.companyId,
      operationType: "campaign_variant",
    }),
  );

  const results = await Promise.all(calls);
  const assets: CampaignAsset[] = [];

  for (const res of results) {
    let raw: any;
    try { raw = JSON.parse(res.text); } catch { raw = {}; }

    const asset: CampaignAsset = {
      id:               randomUUID(),
      campaignId:       prd.id,
      storyId:          story.id,
      channel:          story.channel,
      assetType:        story.assetType,
      text:             String(raw.text ?? ""),
      hashtags:         Array.isArray(raw.hashtags) ? raw.hashtags.map(String) : [],
      mediaDescription: String(raw.mediaDescription ?? ""),
      qualityScore:     70,
      status:           "draft",
      createdAt:        now(),
      updatedAt:        now(),
    };

    const validation = await validateContent(asset.text, card);
    asset.qualityScore   = validation.score;
    asset.voiceValidation = { passed: validation.passed, violations: validation.violations };

    assetStore.set(asset.id, asset);
    saveContentStores().catch(() => {});
    assets.push(asset);
  }

  return assets;
}

/**
 * Look up variant assets by id and return a comparison summary.
 */
export function compareVariants(variantIds: string[]): {
  variants: CampaignAsset[];
  comparison: { id: string; qualityScore: number; textLength: number; hashtagCount: number }[];
} {
  const variants: CampaignAsset[] = [];
  for (const id of variantIds) {
    const asset = assetStore.get(id);
    if (asset) variants.push(asset);
  }
  const comparison = variants.map((v) => ({
    id:            v.id,
    qualityScore:  v.qualityScore,
    textLength:    v.text.length,
    hashtagCount:  v.hashtags.length,
  }));
  return { variants, comparison };
}

export function getDueAssets(): ScheduledAsset[] {
  const nowMs = Date.now();
  return Array.from(scheduleStore.values()).filter(
    (e) => new Date(e.publishAt).getTime() <= nowMs,
  );
}
