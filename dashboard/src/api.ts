/**
 * Typed fetch wrapper for the Fastify DNA Foundry API.
 * All /api/* calls proxy → http://localhost:3101 via Vite dev server.
 * SparkGatekeeper calls go directly to http://localhost:9100 (proxied at /queue, /approve, /deny).
 */

const BASE = '/api'
const GK_BASE = '/gk'

async function request<T>(method: string, path: string, body?: unknown, base = BASE): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`${method} ${path} → ${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

function get<T>(path: string, base = BASE) {
  return request<T>('GET', path, undefined, base)
}

function post<T>(path: string, body: unknown, base = BASE) {
  return request<T>('POST', path, body, base)
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CardField {
  value: string | null
  confidence: number         // 0–1
  source: string
  inferred: boolean
}

export interface Special {
  name: string
  description?: string
  price?: string
  valid_from?: string
  valid_until?: string
}

export interface Socials {
  instagram?: string
  facebook?: string
  x?: string
  tiktok?: string
  linkedin?: string
}

export interface BusinessCard {
  id: string
  version: number
  org_id: string
  name: CardField
  tagline?: CardField
  phone?: CardField
  address?: CardField
  website?: CardField
  hours?: CardField
  offerings?: { items: string[] }
  specials?: Special[]
  socials?: Socials
  voice_logo?: { voice?: string }
  policy?: { donts?: string[]; human_confirm?: string[] }
  updated_at?: string
}

export interface Company {
  id: string
  name: string
  cardVersion: number
  lastUpdated: string
}

export interface BuildStatus {
  status: 'ok' | 'failed' | 'building' | 'unknown'
  sha?: string
  ts?: string
  reason?: string
}

export interface HealthResult {
  ok: boolean
  companyId: string
  score: number
  checks: Record<string, boolean>
  suggestions: string[]
}

export interface ChangelogEntry {
  version: number
  ts: string
  author: string
  summary: string
  fields_changed: string[]
  hash: string
  prev_hash: string | null
}

export interface Changelog {
  company_id: string
  entries: ChangelogEntry[]
}

export interface GreetingResult {
  morning?: string
  afternoon?: string
  evening?: string
  default?: string
  voice?: string
}

export interface Voice {
  id: string
  name: string        // normalised from voiceName at fetch time
  voiceName?: string  // raw field from API (kept for compat)
  provider: 'kokoro' | 'elevenlabs' | 'openai'
  gender?: string
  style?: string
  preview_url?: string
}

export interface ApprovalItem {
  id: string
  action: string
  agent: string
  customer_context: string
  risk_level?: 'low' | 'medium' | 'high'
  created_at: string
  expires_at?: string
}

/** Raw row returned by SparkGatekeeper's GET /held. */
export interface HeldOperation {
  id: string
  card_id: string
  card_version: number
  acting_hash: string
  org_id?: string
  action_id: string
  action_json: string
  trail_json: string
  proposed_at: string
  expires_at: string
  status: string
}

export interface AuditEntry {
  id: string
  action: string
  decision: 'approved' | 'denied'
  decided_at: string
  decided_by?: string
}

export interface CompileResult {
  ok: boolean
  card_id: string
  version: number
  roles: string[]
  out_dir: string
}

/** Runtime provider/model settings. Keys are never returned — only presence. */
export interface ProviderInfo {
  hasKey: boolean
  source: 'settings' | 'env' | null
  hint: string
  models: string[]
}
export interface SettingsResponse {
  ok: boolean
  provider: string
  model: string
  providers: Record<string, ProviderInfo>
}

// ---------------------------------------------------------------------------
// API surface
// ---------------------------------------------------------------------------

export interface PlaygroundMessage {
  id: string
  role: 'customer' | 'agent' | 'system'
  content: string
  timestamp: string
  cardSectionsUsed?: string[]
  gateTriggered?: boolean
  gateReason?: string
}

export interface TestResult {
  test: string
  passed: boolean
  detail: string
}

export interface PlaygroundSession {
  id: string
  companyId: string
  cardVersion: number
  createdAt: string
  messages: PlaygroundMessage[]
  persona?: string
  testResults: TestResult[]
}

function cardField(value: unknown, conf: number, inferred = false): CardField {
  const s = typeof value === 'string' ? value.trim() : ''
  return { value: s || null, confidence: conf, source: 'extractor', inferred }
}

/** The API returns a camelCase ExtractedCard (organizationId, identity.name, …);
 *  the UI's BusinessCard is a flat CardField shape. Normalise in ONE place so
 *  every page consumes the same object — otherwise the review form renders empty
 *  and navigation targets `/company/undefined`. */
export function normalizeCard(raw: any): BusinessCard {
  const identity = raw?.identity ?? {}
  const voice = raw?.voice ?? {}
  const ops = raw?.operations ?? {}
  const prov = raw?.field_provenance ?? {}
  const conf = (k: string) => (typeof prov?.[k]?.confidence === 'number' ? prov[k].confidence : 0.5)
  const inf = (k: string) => Boolean(prov?.[k]?.inferred)
  const offerings = Array.isArray(raw?.offerings) ? raw.offerings : []
  return {
    id: raw?.id ?? '',
    version: raw?.version ?? 1,
    org_id: raw?.organizationId ?? raw?.org_id ?? raw?.organization_id ?? '',
    name:    cardField(identity.name, conf('identity.name'), inf('identity.name')),
    tagline: cardField(identity.tagline, conf('identity.tagline'), inf('identity.tagline')),
    phone:   cardField(identity.phone, conf('identity.phone'), inf('identity.phone')),
    address: cardField(identity.location, conf('identity.location'), inf('identity.location')),
    website: cardField(identity.website, conf('identity.website'), inf('identity.website')),
    hours:   cardField(ops.hours, conf('operations.hours'), inf('operations.hours')),
    offerings: { items: offerings.map((o: any) => o?.name).filter(Boolean) },
    specials: Array.isArray(raw?.specials) ? raw.specials : [],
    socials: identity.socials ?? {},
    voice_logo: { voice: voice.personality ?? '' },
    policy: {
      donts: Array.isArray(voice.donts) ? voice.donts : [],
      human_confirm: Array.isArray(raw?.policy_donts) ? raw.policy_donts : [],
    },
    updated_at: raw?.createdAt ?? raw?.updated_at,
  }
}

export const api = {
  // Extraction & compilation
  extract: async (url: string, orgId: string) =>
    normalizeCard(await post<any>('/extract', { url, orgId })),

  compile: (cardId: string, companyId: string) =>
    post<CompileResult>('/compile', { cardId, companyId }),

  // Greeting
  greeting: (cardId: string, companyId: string) =>
    post<GreetingResult>('/greeting', { cardId, companyId }),

  // Voices
  voices: async (): Promise<Voice[]> => {
    const raw = await get<any[]>('/voices')
    return raw.map((v) => ({ ...v, name: v.name ?? v.voiceName ?? v.id }))
  },

  // Health
  health: (companyId: string) =>
    get<HealthResult>(`/health/${companyId}`),

  // Changelog
  changelog: (companyId: string) =>
    get<Changelog>(`/changelog/${companyId}`),

  // Build status
  buildStatus: () => get<BuildStatus>('/build-status'),

  // Companies (new endpoint added to backend)
  listCompanies: () => get<Company[]>('/companies'),

  // Cards
  getCard: async (cardId: string) => normalizeCard(await get<any>(`/cards/${cardId}`)),

  // SparkGatekeeper (proxied at /gk → 127.0.0.1:9100)
  // The gatekeeper's real contract: GET /held, POST /held/:id/deny,
  // POST /held/:id/challenge + /held/:id/approve (WebAuthn, fail-closed).
  gkQueue: async () => {
    const held = await request<HeldOperation[]>('GET', '/held', undefined, GK_BASE)
    const pending: ApprovalItem[] = held.map((h) => {
      let action = h.action_id
      let context = h.action_json
      let risk: 'low' | 'medium' | 'high' | undefined
      try {
        const a = JSON.parse(h.action_json)
        action = a.tool ?? a.kind ?? a.action ?? h.action_id
        const p = a.payload && typeof a.payload === 'object' ? a.payload : null
        context = p ? `${a.tool ?? a.kind}: ${JSON.stringify(p)}` : (a.summary ?? h.action_json)
        if (a.risk === 'low' || a.risk === 'medium' || a.risk === 'high') risk = a.risk
      } catch { /* keep raw */ }
      return {
        id: h.id,
        action: String(action),
        agent: h.acting_hash ? h.acting_hash.slice(0, 12) : h.card_id,
        customer_context: String(context),
        risk_level: risk,
        created_at: h.proposed_at,
        expires_at: h.expires_at,
      }
    })
    return { pending, audit: [] as AuditEntry[] }
  },

  /** Step 1 of approval: fetch the WebAuthn assertion challenge for a hold.
   *  POST, not GET — the gatekeeper route is post(held_challenge). */
  gkChallenge: (id: string) =>
    request<any>('POST', `/held/${id}/challenge`, undefined, GK_BASE),

  /** Step 2 of approval: post the WebAuthn assertion. The gatekeeper verifies
   *  it server-side; a missing/invalid credential is refused (fail-closed). */
  gkApprove: (id: string, credential: unknown) =>
    request<{ ok: boolean }>('POST', `/held/${id}/approve`, { credential }, GK_BASE),

  gkDeny: (id: string) =>
    request<{ denied: boolean }>('POST', `/held/${id}/deny`, undefined, GK_BASE),

  // Approver-passkey enrollment. /setup/finish answers 200 with an EMPTY body,
  // so it can't go through request<T>() (which always parses JSON).
  gkSetupChallenge: (userId: string, displayName: string) =>
    request<any>('POST', '/setup/challenge', { user_id: userId, display_name: displayName }, GK_BASE),

  gkSetupFinish: async (userId: string, credential: unknown) => {
    const res = await fetch(`${GK_BASE}/setup/finish`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, credential }),
    })
    if (!res.ok) {
      const t = await res.text().catch(() => res.statusText)
      throw new Error(`POST /setup/finish → ${res.status}: ${t}`)
    }
  },


  // Playground
  playgroundCreate: (companyId: string, cardId: string, persona?: string) =>
    post<PlaygroundSession>('/playground/session', { companyId, cardId, persona }),

  playgroundMessage: (sessionId: string, message: string) =>
    post<PlaygroundMessage>('/playground/message', { sessionId, message }),

  playgroundTest: (sessionId: string) =>
    post<{ ok: boolean; results: TestResult[] }>('/playground/test', { sessionId }),

  playgroundClear: (sessionId: string) =>
    request<{ ok: boolean }>('DELETE', `/playground/session/${sessionId}`),

  playgroundSessions: (companyId: string) =>
    get<PlaygroundSession[]>(`/playground/sessions/${companyId}`),

  // Content pipeline
  contentPrd: (companyId: string, cardId: string, goal: string, channels: string[]) =>
    post<{ ok: boolean; prd: any }>('/content/prd', { companyId, cardId, goal, channels }),

  contentGenerate: (companyId: string, cardId: string, prd: any) =>
    post<{ ok: boolean; assets: any[] }>('/content/generate', { companyId, cardId, prd }),

  contentApprove: (assetId: string, companyId: string) =>
    post<{ ok: boolean; holdQueueId: string }>(`/content/approve/${assetId}`, { companyId }),

  getAsset: (assetId: string) =>
    get<any>(`/content/assets/${assetId}`),

  // Scheduling
  scheduleAsset: (assetId: string, companyId: string, publishAt: string) =>
    post<{ ok: boolean; scheduled: any }>(`/content/schedule/${assetId}`, { companyId, publishAt }),

  getScheduled: (companyId: string) =>
    get<{ ok: boolean; scheduled: any[] }>(`/content/schedule/${companyId}`),

  cancelSchedule: (assetId: string) =>
    request<{ ok: boolean }>('DELETE', `/content/schedule/${assetId}`),

  // Campaign export
  campaignExport: (campaignId: string) =>
    get<any>(`/content/campaign/${campaignId}/zip`),

  // Site generator
  generateSite: (companyId: string) =>
    post<{ ok: boolean; companyId: string; generatedAt: string }>('/site/generate', { companyId }),

  listSites: () =>
    get<{ ok: boolean; companies: string[] }>('/sites'),

  // Runtime settings — provider / model / API keys
  getSettings: () => get<SettingsResponse>('/settings'),
  saveSettings: (body: { provider?: string; model?: string; keys?: Record<string, string> }) =>
    request<SettingsResponse>('PUT', '/settings', body),
}
