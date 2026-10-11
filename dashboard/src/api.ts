/**
 * Typed fetch wrapper for the Fastify DNA Foundry API.
 * All /api/* calls proxy → http://localhost:3101 via Vite dev server.
 * SparkGatekeeper calls go directly to http://localhost:9100 (proxied at /queue, /approve, /deny).
 */

const BASE = '/api'
const GK_BASE = '/gk'

// API credentials. Entered by the owner at login and kept in localStorage — NOT
// baked into the bundle, because anything shipped in a Vite build is public.
const KEY_STORE = 'helix_api_key'
const OWNER_STORE = 'helix_owner_key'

export function getApiKey(): string {
  return localStorage.getItem(KEY_STORE) ?? ''
}
export function setApiKey(k: string): void {
  localStorage.setItem(KEY_STORE, k)
}
export function setOwnerKey(k: string): void {
  localStorage.setItem(OWNER_STORE, k)
}
export function clearKeys(): void {
  localStorage.removeItem(KEY_STORE)
  localStorage.removeItem(OWNER_STORE)
}

// ---------------------------------------------------------------------------
// Session auth — ONE credential.
//
// A passkey login sets an HttpOnly session cookie; every call carries it via
// credentials: 'same-origin'. The server maps the session to the company, so the
// per-company API key is never typed into a browser. The key path above remains
// only as break-glass.
// ---------------------------------------------------------------------------

export interface SessionInfo { ok: boolean; company: string; role: 'owner' | 'company' }

export const auth = {
  me: () => request<SessionInfo>('GET', '/auth/me'),
  loginOptions: () => request<{ ok: boolean; options: any }>('POST', '/auth/login/options', {}),
  loginVerify: (response: unknown) => request<SessionInfo>('POST', '/auth/login/verify', { response }),
  registerOptions: (token: string) =>
    request<{ ok: boolean; company: string; options: any }>('POST', '/auth/register/options', { token }),
  registerVerify: (token: string, response: unknown) =>
    request<SessionInfo>('POST', '/auth/register/verify', { token, response }),
  logout: () => request<{ ok: boolean }>('POST', '/auth/logout', {}),
}

/** Non-throwing session probe — used on load to decide locked vs open. */
export async function sessionInfo(): Promise<SessionInfo | null> {
  try {
    return await auth.me()
  } catch {
    return null
  }
}

/** Credential headers — only for the app API, never for the gatekeeper proxy. */
function authHeaders(): Record<string, string> {
  const k = localStorage.getItem(KEY_STORE)
  const o = localStorage.getItem(OWNER_STORE)
  const h: Record<string, string> = {}
  if (k) h['x-api-key'] = k
  if (o) h['x-owner-key'] = o
  return h
}

/** fetch against the API with credentials attached and 401 handled once. */
export async function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = { ...authHeaders(), ...((init.headers as Record<string, string>) ?? {}) }
  const res = await fetch(`${BASE}${path}`, { credentials: 'same-origin', ...init, headers })
  if (res.status === 401) {
    throw new Error(`unauthorized — missing or invalid API key (${path})`)
  }
  return res
}

async function request<T>(method: string, path: string, body?: unknown, base = BASE): Promise<T> {
  const headers: Record<string, string> = base === BASE ? authHeaders() : {}
  if (body) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${base}${path}`, {
    method,
    credentials: 'same-origin', // carry the session cookie (the passkey login)
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (res.status === 401) {
    throw new Error(`unauthorized — missing or invalid API key (${method} ${path})`)
  }
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
  timestamp: string
  fieldsChanged: string[]
  mutationType: string
  previousHash: string
  entryHash: string
  author: string
  note?: string
}

export interface Changelog {
  cardId: string
  companyId: string
  entries: ChangelogEntry[]
  headHash: string
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
  /** The card this hold belongs to — used to scope the per-card approvals tab. */
  card_id?: string
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
 *  and navigation targets `/card/undefined`. */
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

// ---- Per-business AI settings -------------------------------------------

export interface AiAspect { key: string; label: string; hint: string }

export interface AiKeyInfo {
  hasKey: boolean
  source: 'business' | 'account' | 'env' | null
  hint: string
  models: string[]
}

export interface AiEffective { provider: string; model: string; source: string }

export interface CompanyAiResponse {
  ok: boolean
  orgId: string | null
  provider: string | null
  model: string | null
  scopes: Record<string, { provider?: string; model?: string }>
  effective: Record<string, AiEffective>
  keys: Record<string, AiKeyInfo>
  aspects: AiAspect[]
  providers: string[]
  account: { provider: string; model: string }
  budgetCredits: number
}

export interface CompanyAiPatch {
  provider?: string | null
  model?: string | null
  scopes?: Record<string, { provider?: string | null; model?: string | null }>
  keys?: Record<string, string>
  budgetCredits?: number | null
}

export const api = {
  // Extraction & compilation
  extract: async (url: string) =>
    normalizeCard(await post<any>('/extract', { url })),

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

  /** Verify the hash chain of a company's changelog. */
  verifyChangelog: (companyId: string) =>
    get<{ valid: boolean; brokenAt?: number; error?: string }>(`/changelog/${companyId}/verify`),

  /** Changelog rendered as markdown (text/plain, not JSON). */
  changelogMarkdown: async (companyId: string): Promise<string> => {
    const res = await fetch(`${BASE}/changelog/${companyId}/markdown`)
    if (!res.ok) throw new Error(`GET /changelog/${companyId}/markdown → ${res.status}`)
    return res.text()
  },

  // Build status
  buildStatus: () => get<BuildStatus>('/build-status'),

  // Companies (new endpoint added to backend)
  listCompanies: () => get<Company[]>('/companies'),

  // Cards
  getCard: async (cardId: string) => normalizeCard(await get<any>(`/cards/${cardId}`)),

  /** Raw card — everything the API returns, incl. provenance, visual identity,
   *  offerings, strategy and customers. Used by the Card/Overview tabs. */
  getCardRaw: (cardId: string) => get<any>(`/cards/${cardId}`),

  /** Generated landing site for a company (if one has been produced). */
  getSite: (companyId: string) => get<any>(`/site/${companyId}`),

  /** Owner edit. The server never writes the card directly: PATCH records a
   *  proposal (202) and the confirm step applies it — merging, marking named
   *  provenance keys owner-confirmed, bumping the version and logging the
   *  changelog. Two calls, one user action. */
  updateCard: async (cardId: string, patch: Record<string, unknown>, confirm: string[] = [], summary?: string) => {
    const made = await request<{ ok: boolean; status: string; proposal: { id: string } }>(
      'PATCH', `/cards/${cardId}`, { patch, confirm, author: 'owner', summary })
    return request<{ ok: boolean; card: any; fieldsChanged: string[] }>(
      'POST', `/cards/${cardId}/proposals/${made.proposal.id}/confirm`)
  },

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
        card_id: h.card_id,
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

  // Per-business AI — which model each aspect of THIS business runs on.
  getCompanyAi: (orgId: string) =>
    get<CompanyAiResponse>(`/settings/${encodeURIComponent(orgId)}`),
  saveCompanyAi: (orgId: string, body: CompanyAiPatch) =>
    request<CompanyAiResponse>('PUT', `/settings/${encodeURIComponent(orgId)}`, body),
}
