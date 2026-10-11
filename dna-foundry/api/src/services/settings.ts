/**
 * Runtime settings — lets the operator set provider API keys and the default
 * provider/model from the dashboard, instead of only via env.
 *
 * Stored 0600 at /etc/helix/settings.json. Environment variables always act as
 * the fallback, so existing deployments keep working untouched.
 */
import * as fs from "fs/promises";
import * as path from "path";

export const PROVIDERS = [
  "deepseek", "openai", "anthropic", "gemini", "groq", "openrouter", "mistral",
] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PROVIDER_ENV: Record<Provider, string> = {
  deepseek: "DEEPSEEK_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  mistral: "MISTRAL_API_KEY",
};

/** Suggested models per provider (the UI offers free-text too). */
export const PROVIDER_MODELS: Record<Provider, string[]> = {
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  openai: ["gpt-4o-mini", "gpt-4o"],
  anthropic: ["claude-sonnet-4", "claude-3-5-haiku-latest"],
  gemini: ["gemini-3.8-flash", "gemini-3.1-flash-lite", "gemini-3.1-pro-preview"],
  groq: ["llama-3.3-70b-versatile", "mixtral-8x7b-32768"],
  openrouter: ["openrouter/auto"],
  mistral: ["mistral-small-latest", "mistral-large-latest"],
};

export interface Settings {
  provider?: Provider;
  model?: string;
  keys?: Partial<Record<Provider, string>>;
}

const SETTINGS_FILE = process.env.HELIX_SETTINGS_FILE ?? "/etc/helix/settings.json";

/** In-process copy so key lookups on the hot path stay synchronous. */
let current: Settings = {};

export async function loadSettings(): Promise<Settings> {
  try {
    current = JSON.parse(await fs.readFile(SETTINGS_FILE, "utf8"));
  } catch {
    current = {};
  }
  return current;
}

export function getSettings(): Settings {
  return current;
}

export async function saveSettings(next: Settings): Promise<Settings> {
  current = next;
  await fs.mkdir(path.dirname(SETTINGS_FILE), { recursive: true });
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  await fs.chmod(SETTINGS_FILE, 0o600).catch(() => {});
  return current;
}

/** Resolved key: runtime settings first, env fallback. */
export function keyFor(provider: Provider): string | undefined {
  return current.keys?.[provider] || process.env[PROVIDER_ENV[provider]] || undefined;
}

const ENV_TO_PROVIDER: Record<string, Provider> = Object.fromEntries(
  (Object.entries(PROVIDER_ENV) as [Provider, string][]).map(([p, e]) => [e, p]),
) as Record<string, Provider>;

export function providerForEnv(envName: string): Provider | undefined {
  return ENV_TO_PROVIDER[envName];
}

/** Never return raw secrets — only whether one is present and a short hint. */
export function publicSettings() {
  const s = getSettings();
  const providers = Object.fromEntries(
    PROVIDERS.map((p) => {
      const k = keyFor(p);
      return [p, {
        hasKey: Boolean(k),
        source: s.keys?.[p] ? "settings" : (process.env[PROVIDER_ENV[p]] ? "env" : null),
        hint: k ? `${k.slice(0, 4)}…${k.slice(-3)}` : "",
        models: PROVIDER_MODELS[p],
      }];
    }),
  );
  return {
    ok: true,
    provider: s.provider ?? "deepseek",
    model: s.model ?? "deepseek-chat",
    providers,
  };
}

// ---------------------------------------------------------------------------
// Per-business AI configuration
//
// A business can point each *aspect* (the functions that actually call an LLM)
// at its own provider/model, and optionally carry its own provider key.
// Resolution is always: aspect override → business default → account default →
// built-in, with keys as business → account → env. Stored 0600 at
// /etc/helix/companies/<orgId>/ai.json.
// ---------------------------------------------------------------------------

export const ASPECTS: { key: string; label: string; hint: string }[] = [
  { key: "extraction",         label: "DNA extraction",    hint: "Reading a website into a card" },
  { key: "content_generation", label: "Content & copy",    hint: "Posts, emails, ad copy" },
  { key: "campaign_prd",       label: "Campaign planning", hint: "Turning a goal into a plan" },
  { key: "sales_qualify",      label: "Lead qualification",hint: "Scoring inbound leads" },
  { key: "sales_outreach",     label: "Outreach drafting", hint: "Cold email, LinkedIn, call scripts" },
  { key: "sales_review",       label: "Deal review",       hint: "Pipeline health reads" },
  { key: "intel_battle",       label: "Competitive intel", hint: "Battle cards and trends" },
  { key: "site_generate",      label: "Website builder",   hint: "Generating the landing page" },
  { key: "greeting_compile",   label: "Voice greeting",    hint: "Compiling the phone greeting" },
  { key: "playground_message", label: "Playground",        hint: "Test chats with the agent" },
];

export interface ScopeChoice {
  provider?: Provider;
  model?: string;
}

export interface CompanyAiSettings {
  provider?: Provider;                       // this business's default
  model?: string;
  scopes?: Record<string, ScopeChoice>;      // aspect key → override
  keys?: Partial<Record<Provider, string>>;  // optional per-business key
  budgetCredits?: number;                    // monthly credit cap (0/absent = uncapped)
}

const COMPANIES_DIR = process.env.HELIX_COMPANIES_DIR ?? "/etc/helix/companies";

/** orgId → settings. Filled at boot and on every save, read synchronously. */
const companyAi = new Map<string, CompanyAiSettings>();

export function getCompanyAi(orgId?: string): CompanyAiSettings {
  if (!orgId) return {};
  return companyAi.get(orgId) ?? {};
}

/** Populate the in-process cache from disk at boot. */
export async function loadAllCompanyAi(): Promise<number> {
  let n = 0;
  try {
    const entries = await fs.readdir(COMPANIES_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        const raw = JSON.parse(
          await fs.readFile(path.join(COMPANIES_DIR, e.name, "ai.json"), "utf8"),
        ) as CompanyAiSettings;
        companyAi.set(e.name, raw);
        n++;
      } catch {
        // no ai.json for this business — fine
      }
    }
  } catch {
    // companies dir does not exist yet
  }
  return n;
}

export async function saveCompanyAi(orgId: string, next: CompanyAiSettings): Promise<CompanyAiSettings> {
  companyAi.set(orgId, next);
  const dir = path.join(COMPANIES_DIR, orgId);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "ai.json");
  await fs.writeFile(file, JSON.stringify(next, null, 2), { mode: 0o600 });
  await fs.chmod(file, 0o600).catch(() => {});
  return next;
}

function defaultModelFor(p: Provider): string {
  return PROVIDER_MODELS[p]?.[0] ?? "deepseek-chat";
}

/**
 * Model resolution for one call. Returns the source too, so the UI can say
 * honestly where a given model choice is coming from.
 */
export function resolveModel(
  orgId?: string,
  aspect?: string,
): { provider: Provider; model: string; source: string } {
  const c = getCompanyAi(orgId);
  const g = getSettings();
  const scope = aspect ? c.scopes?.[aspect] : undefined;

  if (scope?.model || scope?.provider) {
    const provider = (scope.provider ?? c.provider ?? g.provider ?? "deepseek") as Provider;
    return { provider, model: scope.model || defaultModelFor(provider), source: `business · ${aspect}` };
  }
  if (c.model || c.provider) {
    const provider = (c.provider ?? g.provider ?? "deepseek") as Provider;
    return { provider, model: c.model || defaultModelFor(provider), source: "business default" };
  }
  if (g.model || g.provider) {
    const provider = (g.provider ?? "deepseek") as Provider;
    return { provider, model: g.model || defaultModelFor(provider), source: "account default" };
  }
  return { provider: "deepseek", model: "deepseek-chat", source: "built-in" };
}

/** Key for a provider, scoped: business key → account key → env. */
export function keyForProvider(provider: Provider, orgId?: string): string | undefined {
  return getCompanyAi(orgId).keys?.[provider] || keyFor(provider);
}

/** Monthly credit cap for a business (0 / undefined = uncapped). */
export function budgetCreditsFor(orgId?: string): number {
  const b = getCompanyAi(orgId).budgetCredits;
  return typeof b === "number" && b > 0 ? b : 0;
}

/** Never returns raw secrets — presence, hint and effective resolution only. */
export function publicCompanyAi(orgId?: string) {
  const c = getCompanyAi(orgId);
  const g = getSettings();
  return {
    ok: true,
    orgId: orgId ?? null,
    provider: c.provider ?? null,
    model: c.model ?? null,
    scopes: c.scopes ?? {},
    effective: Object.fromEntries(ASPECTS.map((a) => [a.key, resolveModel(orgId, a.key)])),
    keys: Object.fromEntries(
      PROVIDERS.map((p) => {
        const k = keyForProvider(p, orgId);
        return [
          p,
          {
            hasKey: Boolean(k),
            source: c.keys?.[p] ? "business" : g.keys?.[p] ? "account" : process.env[PROVIDER_ENV[p]] ? "env" : null,
            hint: k ? `${k.slice(0, 4)}…${k.slice(-3)}` : "",
            models: PROVIDER_MODELS[p],
          },
        ];
      }),
    ),
    aspects: ASPECTS,
    providers: PROVIDERS,
    account: { provider: g.provider ?? "deepseek", model: g.model ?? "deepseek-chat" },
    budgetCredits: budgetCreditsFor(orgId),
  };
}
