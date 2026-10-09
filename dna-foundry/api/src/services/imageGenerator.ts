/**
 * imageGenerator — multi-provider image generation with content-addressed cache.
 *
 * Provider cascade (tried in order until one succeeds):
 *   1. DALL-E 3   (OPENAI_API_KEY)       — $0.04/image
 *   2. Stability  (STABILITY_API_KEY)    — $0.002/image
 *   3. Black Forest Labs / FLUX (BFL_API_KEY) — $0.055/image
 *   4. Unsplash   (always available)     — $0.00/image (fallback)
 *
 * Cache: content-addressed Map keyed by sha256(prompt+provider).
 * Cache hit → return immediately, no API call.
 */

import { createHash } from "crypto";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ImageProvider = "dalle3" | "stability" | "bfl" | "unsplash";

export interface ImageRequest {
  prompt: string;
  style?: string;          // photographic, artistic, abstract
  size?: "1024x1024" | "1792x1024" | "1024x1792";
  companyId: string;
  assetType: "product" | "hero" | "social" | "logo_concept" | "background";
}

export interface GeneratedImage {
  url: string;
  provider: ImageProvider;
  prompt: string;
  contentHash: string;     // sha256(prompt+provider) — used as cache key
  costUsd: number;
  cachedPath?: string;     // if saved to disk
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Content-addressed cache
// ---------------------------------------------------------------------------

const imageCache = new Map<string, GeneratedImage>();

// Images stored per companyId for getCompanyImages()
const companyImageIndex = new Map<string, Set<string>>(); // companyId → Set<contentHash>

function contentHash(prompt: string, provider: ImageProvider): string {
  return createHash("sha256").update(prompt + provider).digest("hex");
}

function cacheStore(companyId: string, image: GeneratedImage): void {
  imageCache.set(image.contentHash, image);
  const set = companyImageIndex.get(companyId) ?? new Set<string>();
  set.add(image.contentHash);
  companyImageIndex.set(companyId, set);
}

// ---------------------------------------------------------------------------
// Provider implementations
// ---------------------------------------------------------------------------

// DALL-E 3
async function generateDalle3(
  prompt: string,
  size: string,
): Promise<{ url: string }> {
  const apiKey = process.env.OPENAI_API_KEY!;
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "dall-e-3",
      prompt,
      n: 1,
      size: size as "1024x1024" | "1792x1024" | "1024x1792",
      quality: "standard",
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`DALL-E 3 HTTP ${res.status}: ${text.slice(0, 400)}`);
  }

  const json = (await res.json()) as { data?: Array<{ url?: string }> };
  const url = json.data?.[0]?.url;
  if (!url) throw new Error("DALL-E 3: no url in response");
  return { url };
}

// Stability AI
async function generateStability(prompt: string): Promise<{ url: string }> {
  const apiKey = process.env.STABILITY_API_KEY!;
  const res = await fetch(
    "https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      body: JSON.stringify({
        text_prompts: [{ text: prompt, weight: 1 }],
        cfg_scale: 7,
        height: 1024,
        width: 1024,
        samples: 1,
        steps: 30,
      }),
    },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Stability AI HTTP ${res.status}: ${text.slice(0, 400)}`);
  }

  const json = (await res.json()) as {
    artifacts?: Array<{ base64?: string; finishReason?: string }>;
  };
  const artifact = json.artifacts?.[0];
  if (!artifact?.base64) throw new Error("Stability AI: no base64 in response");

  // Return data URI — caller can persist to disk and swap cachedPath
  const url = `data:image/png;base64,${artifact.base64}`;
  return { url };
}

// Black Forest Labs / FLUX
async function generateBfl(prompt: string): Promise<{ url: string }> {
  const apiKey = process.env.BFL_API_KEY!;
  const res = await fetch("https://api.bfl.ml/v1/flux-pro", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Key": apiKey,
    },
    body: JSON.stringify({
      prompt,
      width: 1024,
      height: 1024,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`BFL/FLUX HTTP ${res.status}: ${text.slice(0, 400)}`);
  }

  const json = (await res.json()) as { sample?: string; id?: string };

  // BFL may return a polling id — if so, poll once
  if (json.sample) return { url: json.sample };

  if (json.id) {
    // Poll for result (up to 30s)
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const poll = await fetch(`https://api.bfl.ml/v1/get_result?id=${json.id}`, {
        headers: { "X-Key": apiKey },
      });
      if (poll.ok) {
        const result = (await poll.json()) as { status?: string; result?: { sample?: string } };
        if (result.status === "Ready" && result.result?.sample) {
          return { url: result.result.sample };
        }
      }
    }
    throw new Error("BFL/FLUX: timed out waiting for result");
  }

  throw new Error("BFL/FLUX: no sample or id in response");
}

// Unsplash (free fallback)
async function generateUnsplash(prompt: string): Promise<{ url: string }> {
  const clientId = process.env.UNSPLASH_ACCESS_KEY;
  const query = prompt.trim().split(/\s+/).slice(0, 3).join(" ");

  const params = new URLSearchParams({
    query,
    orientation: "landscape",
    ...(clientId ? { client_id: clientId } : {}),
  });

  const res = await fetch(
    `https://api.unsplash.com/photos/random?${params.toString()}`,
    {
      headers: clientId ? {} : { Authorization: `Client-ID ${clientId}` },
    },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Unsplash HTTP ${res.status}: ${text.slice(0, 400)}`);
  }

  const json = (await res.json()) as { urls?: { regular?: string } };
  const url = json.urls?.regular;
  if (!url) throw new Error("Unsplash: no url in response");
  return { url };
}

// ---------------------------------------------------------------------------
// Provider cascade
// ---------------------------------------------------------------------------

interface ProviderAttempt {
  provider: ImageProvider;
  available: boolean;
  costUsd: number;
  generate: (prompt: string, size: string) => Promise<{ url: string }>;
}

function buildCascade(prompt: string): ProviderAttempt[] {
  return [
    {
      provider:  "dalle3",
      available: Boolean(process.env.OPENAI_API_KEY),
      costUsd:   0.04,
      generate:  (_p, size) => generateDalle3(prompt, size),
    },
    {
      provider:  "stability",
      available: Boolean(process.env.STABILITY_API_KEY),
      costUsd:   0.002,
      generate:  () => generateStability(prompt),
    },
    {
      provider:  "bfl",
      available: Boolean(process.env.BFL_API_KEY),
      costUsd:   0.055,
      generate:  () => generateBfl(prompt),
    },
    {
      provider:  "unsplash",
      available: true,   // always available
      costUsd:   0,
      generate:  () => generateUnsplash(prompt),
    },
  ];
}

// ---------------------------------------------------------------------------
// generateImage
// ---------------------------------------------------------------------------

/**
 * Generate an image using the provider cascade, checking content-addressed
 * cache first.
 *
 * Tries providers in order: DALL-E 3 → Stability → BFL → Unsplash.
 * Throws ALL_PROVIDERS_FAILED if every provider fails.
 */
export async function generateImage(req: ImageRequest): Promise<GeneratedImage> {
  const size = req.size ?? "1024x1024";
  const cascade = buildCascade(req.prompt);
  const errors: string[] = [];

  for (const attempt of cascade) {
    if (!attempt.available) continue;

    // Content-addressed cache check
    const hash = contentHash(req.prompt, attempt.provider);
    const cached = imageCache.get(hash);
    if (cached) return cached;

    try {
      const { url } = await attempt.generate(req.prompt, size);

      const image: GeneratedImage = {
        url,
        provider:      attempt.provider,
        prompt:        req.prompt,
        contentHash:   hash,
        costUsd:       attempt.costUsd,
        generatedAt:   new Date().toISOString(),
      };

      cacheStore(req.companyId, image);
      return image;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`[${attempt.provider}] ${msg}`);
      // Continue to next provider
    }
  }

  throw new Error(
    `ALL_PROVIDERS_FAILED: no image provider succeeded.\n${errors.join("\n")}`,
  );
}

// ---------------------------------------------------------------------------
// getCompanyImages
// ---------------------------------------------------------------------------

/**
 * Return all cached images that were generated for a given companyId.
 */
export function getCompanyImages(companyId: string): GeneratedImage[] {
  const hashes = companyImageIndex.get(companyId);
  if (!hashes) return [];
  const images: GeneratedImage[] = [];
  for (const hash of hashes) {
    const img = imageCache.get(hash);
    if (img) images.push(img);
  }
  return images;
}
