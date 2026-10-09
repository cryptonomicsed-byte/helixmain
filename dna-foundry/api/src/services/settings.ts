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
  gemini: ["gemini-1.5-flash", "gemini-1.5-pro"],
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
