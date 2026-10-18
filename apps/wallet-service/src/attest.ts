/**
 * Agent attestations (docs/ARCHITECTURE.md §20.1): an agent proves which wallet it is to a service
 * (the brokerage's sell and portfolio calls) without ever holding its key.
 *
 * 1. The agent picks a random nonce and asks its wallet: `POST /v1/attest { audience, nonce }`.
 * 2. The wallet signs a fixed, human-readable text with the agent's key (EIP-191 personal_sign) and
 *    returns it, plus `header`: the value to send as `X-Allowance-Attestation`.
 * 3. The service rebuilds the text and checks the signature with viem: the address that signed is
 *    the caller. It accepts each nonce once, for 2 minutes, and only for its own audience.
 *
 * The text can't be mistaken for a payment: EIP-191 messages and the EIP-712 transfer authorizations
 * the wallet also signs hash differently, and the text says it authorizes nothing.
 *
 * Imported by the brokerage too (relative import), so signer and verifier share one format.
 */
import { getAddress, isAddress, verifyMessage } from "viem";
import type { Address, Hex } from "viem";

export const ATTESTATION_HEADER = "x-allowance-attestation";
/** How long an attestation is good for, from the wallet's `issuedAt` (either side of it, for clock skew). */
export const ATTESTATION_MAX_AGE_MS = 120_000;
export const ATTESTATION_NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_AUDIENCE = 200;
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;

export interface Attestation {
  address: Address;
  /** The service it is meant for: an http(s) URL without query, e.g. "http://localhost:4110/brokerage". */
  audience: string;
  nonce: string;
  /** ISO time, set by the wallet. */
  issuedAt: string;
  signature: Hex;
}

/** The exact text the agent's key signs. */
export function attestationMessage(a: Omit<Attestation, "signature">): string {
  return [
    "Allowance agent attestation",
    `Audience: ${a.audience}`,
    `Address: ${getAddress(a.address)}`,
    `Nonce: ${a.nonce}`,
    `Issued: ${a.issuedAt}`,
    "This proves which wallet is asking. It authorizes no payment.",
  ].join("\n");
}

/** origin + path without a trailing slash; null unless it is a plain http(s) URL (no credentials, query or fragment). */
export function normalizeAudience(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim() || raw.length > MAX_AUDIENCE) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || u.search || u.hash) return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

/** The `X-Allowance-Attestation` header value: base64url of the attestation as JSON. */
export function encodeAttestation(a: Attestation): string {
  return Buffer.from(JSON.stringify(a), "utf8").toString("base64url");
}

export function decodeAttestation(header: string | undefined): Attestation | null {
  if (!header || header.length > 2000) return null;
  try {
    const a = JSON.parse(Buffer.from(header.trim(), "base64url").toString("utf8")) as Partial<Attestation>;
    if (!a || typeof a !== "object") return null;
    if (typeof a.address !== "string" || !isAddress(a.address)) return null;
    if (typeof a.audience !== "string" || typeof a.nonce !== "string" || typeof a.issuedAt !== "string") return null;
    if (typeof a.signature !== "string" || !SIGNATURE_RE.test(a.signature)) return null;
    return { address: getAddress(a.address), audience: a.audience, nonce: a.nonce, issuedAt: a.issuedAt, signature: a.signature as Hex };
  } catch {
    return null;
  }
}

/** Nonces already accepted, kept until they could no longer be fresh. */
export class NonceCache {
  #seen = new Map<string, number>();
  /** Claims `nonce` (false if it was already used). Synchronous, so two concurrent requests can't both claim it. */
  claim(nonce: string, now: number): boolean {
    for (const [n, until] of this.#seen) if (until < now) this.#seen.delete(n);
    if (this.#seen.has(nonce)) return false;
    this.#seen.set(nonce, now + 2 * ATTESTATION_MAX_AGE_MS);
    return true;
  }
}

export type AttestationCheck = { ok: true; address: Address; attestation: Attestation } | { ok: false; reason: string };

/**
 * Check an `X-Allowance-Attestation` header: well formed, meant for one of `audiences`, fresh, signed
 * by `address`, nonce never seen. The nonce is claimed only once everything else holds.
 */
export async function verifyAttestation(header: string | undefined, opts: { audiences: readonly string[]; nonces: NonceCache; now?: number }): Promise<AttestationCheck> {
  const a = decodeAttestation(header);
  if (!a) return { ok: false, reason: "missing or malformed X-Allowance-Attestation header" };
  const audience = normalizeAudience(a.audience);
  const accepted = opts.audiences.map(normalizeAudience).filter((x): x is string => x !== null);
  if (!audience || !accepted.includes(audience)) return { ok: false, reason: `the attestation is for ${a.audience}, not this service` };
  if (!ATTESTATION_NONCE_RE.test(a.nonce)) return { ok: false, reason: "bad nonce" };
  const now = opts.now ?? Date.now();
  const issued = Date.parse(a.issuedAt);
  if (!Number.isFinite(issued) || Math.abs(now - issued) > ATTESTATION_MAX_AGE_MS) return { ok: false, reason: "the attestation expired; ask the wallet for a new one" };
  let valid = false;
  try {
    valid = await verifyMessage({ address: a.address, message: attestationMessage(a), signature: a.signature });
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "the signature does not match the address" };
  if (!opts.nonces.claim(a.nonce, now)) return { ok: false, reason: "this attestation was already used" };
  return { ok: true, address: a.address, attestation: a };
}
