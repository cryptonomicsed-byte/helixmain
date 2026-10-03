
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
    extraPath?: string
  ) => {
    // Null stays null: no endpoint declared, no rule emitted. The agent
    // simply cannot reach that surface. Never invent a host.
    if (!ep) return;
    const endpoint: { host: string; port: number; path?: string } = {
      host: ep.host,
      port: ep.port,
    };
    if (ep.path ?? extraPath) endpoint.path = ep.path ?? extraPath;
    network_policies[key] = {
      name: `${name} [${card.id} v${card.version}]`,
      endpoints: [endpoint],
      binaries: [{ path: runtime.agentBinaryPath }],
    };
  };

  allow("hold_queue_sidecar", "hold-queue sidecar", runtime.holdQueue, "/mcp/*");
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
