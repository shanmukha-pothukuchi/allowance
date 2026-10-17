/** Minimal agent-work client (spec: docs/agent-work-spec.md). Plain fetch, no dependencies. */
import type { AgentWorkDoc, BountyDoc, ClaimResponse, PayoutResponse, AgentWorkError as AgentWorkErrorBody } from "@allowance/shared";

export class AgentWorkError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function discover(siteUrl: string): Promise<AgentWorkDoc> {
  const base = siteUrl.startsWith("http") ? siteUrl : `http://${siteUrl}`;
  const url = base.includes("/.well-known/agent-work") ? base : `${base.replace(/\/$/, "")}/.well-known/agent-work`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new AgentWorkError(res.status, "discover_failed", `GET ${url} → ${res.status}`);
  return (await res.json()) as AgentWorkDoc;
}

export async function claim(bounty: BountyDoc, walletAddress: string, agentName?: string): Promise<ClaimResponse> {
  const res = await fetch(bounty.claimUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ walletAddress, agentName }),
  });
  const data = (await res.json()) as ClaimResponse | AgentWorkErrorBody;
  if (res.status !== 201) {
    const e = data as AgentWorkErrorBody;
    throw new AgentWorkError(res.status, e.error ?? "claim_failed", e.message ?? `claim → ${res.status}`, e.details);
  }
  return data as ClaimResponse;
}

export async function submit(c: ClaimResponse, walletAddress: string, result: unknown): Promise<PayoutResponse> {
  const res = await fetch(c.submitUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ claimId: c.claimId, walletAddress, result }),
  });
  const data = (await res.json()) as PayoutResponse | AgentWorkErrorBody;
  if (res.status !== 200) {
    const e = data as AgentWorkErrorBody;
    throw new AgentWorkError(res.status, e.error ?? "submit_failed", e.message ?? `submit → ${res.status}`, e.details);
  }
  return data as PayoutResponse;
}
