/**
 * webauthn.ts — the owner's passkey ceremony (registration + authentication).
 *
 * RP identity is the dashboard's own origin, env-overridable so a local run can
 * point at localhost. The per-ceremony challenge is kept in a SIGNED COOKIE
 * (session.ts signJson/verifyJson), never in server memory: a restart between
 * "options" and "verify" would otherwise kill the ceremony, and an in-process map
 * is one more thing to leak.
 *
 * Uses @simplewebauthn/server v9 (the same family the browser side already uses).
 */
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type { StoredCredential } from "./passkeys";

export const RP_ID = process.env.HELIX_RP_ID || "helixmain.duckdns.org";
export const RP_ORIGIN = process.env.HELIX_RP_ORIGIN || "https://helixmain.duckdns.org";
export const RP_NAME = "HelixMain Owner Dashboard";

/** Begin registration. Resident (discoverable) keys + required UV so login can be
 *  a single tap with no username. Existing creds are excluded so a device can't
 *  silently double-enroll. */
export async function registrationOptions(
  company: string,
  existing: StoredCredential[],
): Promise<Record<string, unknown>> {
  const opts = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userID: Buffer.from(company, "utf8"),
    userName: company,
    userDisplayName: company,
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({
      id: c.id,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      transports: (c.transports ?? []) as any,
    })),
    authenticatorSelection: {
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
    },
  });
  return opts as unknown as Record<string, unknown>;
}

export interface RegistrationOutcome {
  id: string;
  publicKey: string;
  counter: number;
  transports: string[];
}

/** Complete registration. Throws on any verification failure (fail-closed). */
export async function verifyRegistration(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  response: any,
  expectedChallenge: string,
): Promise<RegistrationOutcome> {
  const result = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: RP_ORIGIN,
    expectedRPID: RP_ID,
    requireUserVerification: true,
  });
  if (!result.verified || !result.registrationInfo) {
    throw new Error("registration not verified");
  }
  const info = result.registrationInfo;
  return {
    id: info.credentialID,
    publicKey: Buffer.from(info.credentialPublicKey).toString("base64url"),
    counter: info.counter,
    // transports aren't reliably reported in the attestation; the browser supplies
    // them on the next get(), so an empty hint is correct rather than guessed.
    transports: [],
  };
}

/** Begin authentication. Empty allowCredentials => the authenticator offers its
 *  resident credential (usernameless login); we resolve the company by credential id. */
export async function authenticationOptions(): Promise<Record<string, unknown>> {
  const opts = await generateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: "required",
  });
  return opts as unknown as Record<string, unknown>;
}

export interface AuthenticationOutcome {
  newCounter: number;
}

/** Complete authentication against a stored credential. Throws on failure. */
export async function verifyAuthentication(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  response: any,
  expectedChallenge: string,
  cred: StoredCredential,
): Promise<AuthenticationOutcome> {
  const result = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: RP_ORIGIN,
    expectedRPID: RP_ID,
    requireUserVerification: true,
    authenticator: {
      credentialID: cred.id,
      credentialPublicKey: Buffer.from(cred.publicKey, "base64url"),
      counter: cred.counter,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      transports: (cred.transports ?? []) as any,
    },
  });
  if (!result.verified) throw new Error("authentication not verified");
  return { newCounter: result.authenticationInfo.newCounter };
}
