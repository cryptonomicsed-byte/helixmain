/**
 * channelGrants — MCP channel grant derivation + H-gated email/social sends.
 *
 * All send/post actions are H-gated through SparkGatekeeper:
 *   sendEmail() and postToSocial() POST to localhost:9100/hold and return holdQueueId.
 *   Messages are NEVER delivered without owner approval in the hold queue.
 *
 * Channel grants are derived from card.operations.channels[].
 * Each channel type maps to specific MCP tool names.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ChannelType =
  | "voice"
  | "email"
  | "sms"
  | "instagram"
  | "facebook"
  | "x"
  | "linkedin"
  | "tiktok";

export interface ChannelGrant {
  channelType: ChannelType;
  handle: string;
  verified: boolean;
  grantedTools: string[];     // MCP tool names this channel unlocks
  requiresApproval: boolean;  // all sends/posts need SparkGatekeeper
}

// ---------------------------------------------------------------------------
// Tool map
// ---------------------------------------------------------------------------

const CHANNEL_TOOLS: Record<ChannelType, string[]> = {
  voice:     ["telephony.answer", "telephony.transfer"],
  email:     ["email.draft", "email.send"],
  sms:       ["sms.draft", "sms.send"],
  instagram: ["social.draft", "social.post"],
  facebook:  ["social.draft", "social.post"],
  x:         ["social.draft", "social.post"],
  linkedin:  ["social.draft", "social.post"],
  tiktok:    ["social.draft", "social.post"],
};

// Tools that require SparkGatekeeper approval before execution
const APPROVAL_REQUIRED_TOOLS = new Set([
  "telephony.transfer",
  "email.send",
  "sms.send",
  "social.post",
]);

function channelRequiresApproval(channelType: ChannelType): boolean {
  const tools = CHANNEL_TOOLS[channelType] ?? [];
  return tools.some((t) => APPROVAL_REQUIRED_TOOLS.has(t));
}

// ---------------------------------------------------------------------------
// deriveChannelGrants
// ---------------------------------------------------------------------------

/**
 * Derive channel grants from a card's operations.channels[].
 *
 * Each channel object in the card should have:
 *   { type: ChannelType, handle?: string, verified?: boolean }
 *
 * Unknown channel types are silently skipped.
 */
export function deriveChannelGrants(card: any): ChannelGrant[] {
  const channels: any[] = card?.operations?.channels ?? [];
  if (!Array.isArray(channels)) return [];

  const grants: ChannelGrant[] = [];

  for (const ch of channels) {
    const channelType = ch?.type as ChannelType | undefined;
    if (!channelType || !(channelType in CHANNEL_TOOLS)) continue;

    grants.push({
      channelType,
      handle:          String(ch.handle ?? ch.address ?? ch.email ?? ""),
      verified:        Boolean(ch.verified ?? false),
      grantedTools:    CHANNEL_TOOLS[channelType],
      requiresApproval: channelRequiresApproval(channelType),
    });
  }

  return grants;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ChannelNotGranted extends Error {
  constructor(channelType: ChannelType) {
    super(`ChannelNotGranted: '${channelType}' is not in this card's operations.channels`);
    this.name = "ChannelNotGranted";
  }
}

// ---------------------------------------------------------------------------
// SparkGatekeeper hold queue
// ---------------------------------------------------------------------------

const SPARK_GATEKEEPER_URL = "http://localhost:9100/hold";

async function submitToHoldQueue(payload: Record<string, unknown>): Promise<string> {
  let res: Response;
  try {
    res = await fetch(SPARK_GATEKEEPER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `SparkGatekeeper unreachable — action NOT submitted. Original error: ${msg}`,
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
    throw new Error("SparkGatekeeper response missing 'id' — action NOT submitted.");
  }

  return json.id;
}

// ---------------------------------------------------------------------------
// Email provider detection
// ---------------------------------------------------------------------------

type EmailProvider = "resend" | "sendgrid" | "mailgun" | "unconfigured";

function detectEmailProvider(): EmailProvider {
  if (process.env.RESEND_API_KEY)    return "resend";
  if (process.env.SENDGRID_API_KEY)  return "sendgrid";
  if (process.env.MAILGUN_API_KEY)   return "mailgun";
  console.warn(
    "[channelGrants] No email provider API key found (RESEND_API_KEY / SENDGRID_API_KEY / MAILGUN_API_KEY). " +
    "Submitting to hold queue with provider=unconfigured.",
  );
  return "unconfigured";
}

// ---------------------------------------------------------------------------
// sendEmail
// ---------------------------------------------------------------------------

/**
 * Submit an email send to SparkGatekeeper's hold queue.
 * The email is NEVER sent directly — it waits for owner approval.
 *
 * Throws ChannelNotGranted if 'email' is not in card.operations.channels.
 * Throws if SparkGatekeeper is unreachable.
 */
export async function sendEmail(
  companyId: string,
  to: string,
  subject: string,
  body: string,
  card: any,
): Promise<{ holdQueueId: string }> {
  // Validate channel is granted
  const grants = deriveChannelGrants(card);
  const emailGrant = grants.find((g) => g.channelType === "email");
  if (!emailGrant) {
    throw new ChannelNotGranted("email");
  }

  const provider = detectEmailProvider();

  const holdQueueId = await submitToHoldQueue({
    companyId,
    action: "email.send",
    risk: "medium",
    payload: {
      provider,
      to,
      subject,
      body,
    },
  });

  return { holdQueueId };
}

// ---------------------------------------------------------------------------
// postToSocial
// ---------------------------------------------------------------------------

/**
 * Submit a social post to SparkGatekeeper's hold queue.
 * The post is NEVER published directly — it waits for owner approval.
 *
 * Throws ChannelNotGranted if the channel type is not in card.operations.channels.
 * Throws if SparkGatekeeper is unreachable.
 */
export async function postToSocial(
  companyId: string,
  channel: "instagram" | "facebook" | "x" | "linkedin",
  content: string,
  mediaUrl?: string,
  card?: any,
): Promise<{ holdQueueId: string }> {
  // Validate channel is granted (if a card is provided)
  if (card) {
    const grants = deriveChannelGrants(card);
    const socialGrant = grants.find((g) => g.channelType === channel);
    if (!socialGrant) {
      throw new ChannelNotGranted(channel);
    }
  }

  const holdPayload: Record<string, unknown> = {
    companyId,
    action: "social.post",
    risk: "medium",
    payload: {
      channel,
      content,
      ...(mediaUrl ? { mediaUrl } : {}),
    },
  };

  const holdQueueId = await submitToHoldQueue(holdPayload);
  return { holdQueueId };
}
