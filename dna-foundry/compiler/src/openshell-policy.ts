
import { actingHash } from "./card-md";

/**
 * card.compile_openshell_policy — card -> OpenShell PolicyDocument.
 *
 * Emits the REAL OpenShell policy schema, verified against
 * NVIDIA/OpenShell crates/openshell-policy-schema/src/lib.rs:
 *   version, filesystem_policy, landlock, process,
 *   network_policies (live-updatable), network_middlewares.
 * Unknown fields are rejected by OpenShell (deny_unknown_fields), so this
 * emits exactly that schema and nothing else.
 *
 * Enforcement model: default deny. The agent binary may reach precisely the
 * endpoints declared in runtimeConfig. Endpoints are NEVER invented: a null
 * holdQueue/inference/pocketbase means no rule is emitted for it (null stays
 * null). The card's Operations section declares channels/systems, not hosts —
 * hosts/ports come from the sandbox runtime config supplied by the operator.
 *
 * Card binding: the returned wrapper carries card_id, card_version and
 * acting_hash. When acting sections change, acting_hash changes, and the
 * operator must recompile and reapply — network_policies are live, so the
 * hold queue can also tighten them at runtime for one-shot grants.
 */

export interface SandboxEndpoint {
  host: string;
  port: number;
  path?: string;
}

/** Standard deploy path for the SparkGatekeeper stdio MCP shim (spark__invoke). */
export const DEFAULT_MCP_SERVER_BINARY = "/usr/local/bin/spark-gate-mcp";

export interface SandboxRuntimeConfig {
  /** Absolute path of the agent binary inside the sandbox, e.g. /usr/local/bin/zeroclaw */
  agentBinaryPath: string;
  /** Hold-queue sidecar. Null = agent has no tool-bus path. */
  holdQueue: SandboxEndpoint | null;
  /** Inference endpoint (e.g. DeepSeek via OpenRouter). Null = no model access. */
  inference: SandboxEndpoint | null;
  /** Per-card PocketBase ops store. Null = no ops store. */
  pocketbase: SandboxEndpoint | null;
  /** Read-only mount carrying CARD.md + compiled soul.md/memory.md */
  cardMountPath?: string;
  /** Per-card read-write data dir (PocketBase volume) */
  dataPath?: string;
  runAsUser?: string;
  /**
   * Absolute path of the MCP shim binary that reaches the hold queue on the
   * agent's behalf (stdio MCP server -> POST /invoke). Defaults to the standard
   * deploy path when omitted; pass "" to declare no shim. Emitted alongside
   * agentBinaryPath in the HOLD-QUEUE egress rule only — never replacing it, and
   * never granted to the inference/pocketbase rules, which the shim does not use.
   */
  mcpServerBinary?: string;
}

export interface OpenshellPolicyDocument {
  version: 1;
  filesystem_policy: {
    include_workdir: boolean;
    read_only: string[];
    read_write: string[];
  };
  landlock: { compatibility: "hard_requirement" };
  process: { run_as_user: string; run_as_group: string };
  network_policies: Record<
    string,
    {
      name: string;
      endpoints: { host: string; port: number; path?: string }[];
      binaries: { path: string }[];
    }
  >;
}

export interface CompiledOpenshellPolicy {
  card_id: string;
  card_version: number;
  acting_hash: string;
  policy: OpenshellPolicyDocument;
}

export function compileOpenshellPolicy(
  card: any,
  runtime: SandboxRuntimeConfig
): CompiledOpenshellPolicy {
  if (!card?.id) throw new Error("compileOpenshellPolicy: card.id is required");
  if (!runtime?.agentBinaryPath)
    throw new Error("compileOpenshellPolicy: runtime.agentBinaryPath is required");

  const user = runtime.runAsUser ?? "agent";
  const cardMount = runtime.cardMountPath ?? `/card/${card.id}`;
  const dataPath = runtime.dataPath ?? `/data/${card.id}`;

  const network_policies: OpenshellPolicyDocument["network_policies"] = {};
  const allow = (
    key: string,
    name: string,
    ep: SandboxEndpoint | null,
    extraPath?: string,
    extraBinaries: string[] = []
  ) => {
    // Null stays null: no endpoint declared, no rule emitted. The agent
    // simply cannot reach that surface. Never invent a host.
    if (!ep) return;
    const endpoint: { host: string; port: number; path?: string } = {
      host: ep.host,
      port: ep.port,
    };
    if (ep.path ?? extraPath) endpoint.path = ep.path ?? extraPath;
    // Which binaries may reach THIS endpoint: the agent binary always, plus any
    // extras (e.g. the MCP shim, which reaches the hold queue on the agent's
    // behalf). Deduped, so an equal path is emitted once.
    const paths = [runtime.agentBinaryPath, ...extraBinaries].filter(
      (p, i, a) => !!p && a.indexOf(p) === i
    );
    network_policies[key] = {
      name: `${name} [${card.id} v${card.version}]`,
      endpoints: [endpoint],
      binaries: paths.map((p) => ({ path: p })),
    };
  };

  // The hold queue is the one endpoint a second binary legitimately reaches: the
  // MCP shim forwards the agent's action to POST /invoke. Both binaries are
  // listed; the agent path is never replaced. "" declares no shim.
  const mcpBinary = runtime.mcpServerBinary ?? DEFAULT_MCP_SERVER_BINARY;
  allow("hold_queue_sidecar", "hold-queue sidecar", runtime.holdQueue, "/invoke", [mcpBinary]);
  allow("inference", "inference endpoint", runtime.inference);
  allow("pocketbase", "per-card ops store", runtime.pocketbase);

  return {
    card_id: card.id,
    card_version: card.version,
    acting_hash: actingHash(card),
    policy: {
      version: 1,
      filesystem_policy: {
        include_workdir: true,
        read_only: ["/opt", "/usr", "/lib", "/etc", cardMount],
        read_write: ["/tmp", dataPath],
      },
      landlock: { compatibility: "hard_requirement" },
      process: { run_as_user: user, run_as_group: user },
      network_policies,
    },
  };
}

/**
 * card.compile_openshell_policy -> YAML string (the form OpenShell consumes).
 *
 * Hand-rolled — no YAML dependency — and deterministic: fixed key order, no
 * timestamps, so the same card always yields byte-identical output. The schema
 * is the one compileOpenshellPolicy emits, which mirrors
 * NVIDIA/OpenShell crates/openshell-policy-schema (deny_unknown_fields), so
 * there is nothing extra to emit and nothing extra allowed.
 */
export function emitOpenshellPolicyYaml(compiled: CompiledOpenshellPolicy): string {
  const { card_id, card_version, acting_hash, policy } = compiled;
  // Quote only where YAML would otherwise misread: reserved indicators, leading/
  // trailing space, or an empty string.
  const q = (s: string): string =>
    s === "" || /[:#\-?,[\]{}&*!|>'"%@`\n]/.test(s) || /^\s|\s$/.test(s)
      ? JSON.stringify(s)
      : s;

  const L: string[] = [];
  L.push(`# generated by card.compile_openshell_policy — do not hand-edit`);
  L.push(`# card: ${card_id} v${card_version}`);
  L.push(`# acting_hash: ${acting_hash}`);
  L.push(`version: ${policy.version}`);
  L.push(`filesystem_policy:`);
  L.push(`  include_workdir: ${policy.filesystem_policy.include_workdir}`);
  L.push(`  read_only:`);
  for (const p of policy.filesystem_policy.read_only) L.push(`    - ${q(p)}`);
  L.push(`  read_write:`);
  for (const p of policy.filesystem_policy.read_write) L.push(`    - ${q(p)}`);
  L.push(`landlock:`);
  L.push(`  compatibility: ${policy.landlock.compatibility}`);
  L.push(`process:`);
  L.push(`  run_as_user: ${q(policy.process.run_as_user)}`);
  L.push(`  run_as_group: ${q(policy.process.run_as_group)}`);
  L.push(`network_policies:`);
  for (const [key, np] of Object.entries(policy.network_policies)) {
    L.push(`  ${key}:`);
    L.push(`    name: ${q(np.name)}`);
    L.push(`    endpoints:`);
    for (const e of np.endpoints) {
      L.push(`      - host: ${q(e.host)}`);
      L.push(`        port: ${e.port}`);
      if (e.path !== undefined) L.push(`        path: ${q(e.path)}`);
    }
    L.push(`    binaries:`);
    for (const b of np.binaries) L.push(`      - path: ${q(b.path)}`);
  }
  return L.join("\n") + "\n";
}
