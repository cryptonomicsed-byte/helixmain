export interface HealthScore {
  score: number;           // 0-100
  label: 'excellent' | 'good' | 'needs work';
  completedChecks: string[];
  missingChecks: string[];
  suggestions: string[];
}

interface CheckDef {
  key: string;
  label: string;
  pass: (card: any) => boolean;
  suggestion: string;
}

const CHECKS: CheckDef[] = [
  {
    key: "identity.name",
    label: "Business name",
    pass: (c) => Boolean(c?.identity?.name),
    suggestion: "Add your business name",
  },
  {
    key: "identity.elevator_pitch",
    label: "Elevator pitch",
    pass: (c) => Boolean(c?.identity?.elevator_pitch),
    suggestion: "Add a short elevator pitch describing your business",
  },
  {
    key: "identity.phone",
    label: "Phone number",
    pass: (c) => Boolean(c?.identity?.phone),
    suggestion: "Add a phone number so customers can reach you",
  },
  {
    key: "identity.location",
    label: "Location / address",
    pass: (c) => Boolean(c?.identity?.location),
    suggestion: "Add your business address so customers can find you",
  },
  {
    key: "identity.website",
    label: "Website",
    pass: (c) => Boolean(c?.identity?.website),
    suggestion: "Add your website URL",
  },
  {
    key: "voice.tone",
    label: "Voice tone",
    pass: (c) => Boolean(c?.voice?.tone),
    suggestion: "Define the tone your AI agent should use when speaking",
  },
  {
    key: "voice.personality",
    label: "Voice personality",
    pass: (c) => Boolean(c?.voice?.personality),
    suggestion: "Add a personality description for your AI agent",
  },
  {
    key: "offerings",
    label: "At least one offering",
    pass: (c) => Array.isArray(c?.offerings) && c.offerings.length > 0,
    suggestion: "Add at least one service or product offering",
  },
  {
    key: "operations.hours",
    label: "Business hours",
    pass: (c) => Boolean(c?.operations?.hours),
    suggestion: "Add your business hours so the greeting can mention them",
  },
  {
    key: "identity.review_url",
    label: "Review URL",
    pass: (c) => Boolean(c?.identity?.review_url),
    suggestion: "Add your Google review link to get the review QR code",
  },
  {
    key: "identity.socials",
    label: "Social media handles",
    pass: (c) => {
      const s = c?.identity?.socials;
      return Boolean(s && typeof s === "object" && Object.keys(s).length > 0);
    },
    suggestion: "Add your social media handles to show them on your public page",
  },
  {
    key: "specials",
    label: "Specials or menu items",
    pass: (c) => Array.isArray(c?.specials) && c.specials.length > 0,
    suggestion: "Add daily specials or menu items for the greeting to mention",
  },
  {
    key: "offerings.count",
    label: "Three or more offerings",
    pass: (c) => Array.isArray(c?.offerings) && c.offerings.length >= 3,
    suggestion: "Add more offerings so customers know what you offer",
  },
  {
    key: "policies",
    label: "At least one policy",
    pass: (c) => Array.isArray(c?.policies) && c.policies.length >= 1,
    suggestion: "Add at least one policy (refunds, allergens, etc.) to set expectations",
  },
  {
    key: "operations.response_sla",
    label: "Response SLA",
    pass: (c) => Boolean(c?.operations?.response_sla),
    suggestion: "Add a response time promise to build customer trust",
  },
];

export function scoreCard(card: any): HealthScore {
  const completedChecks: string[] = [];
  const missingChecks: string[] = [];
  const suggestions: string[] = [];

  for (const check of CHECKS) {
    if (check.pass(card)) {
      completedChecks.push(check.label);
    } else {
      missingChecks.push(check.label);
      suggestions.push(check.suggestion);
    }
  }

  const score = Math.round((completedChecks.length / CHECKS.length) * 100);
  const label: HealthScore['label'] =
    score >= 85 ? 'excellent' :
    score >= 65 ? 'good' :
    'needs work';

  return { score, label, completedChecks, missingChecks, suggestions };
}
