/** postMessage contract for the approval embed (§13.5). Pure builders, so they are unit-tested. */
import type { ApprovalStatus } from "./types";

/** What the embed knows. "not_found" is shown in the card but never posted (not in §13.5). */
export type EmbedStatus = ApprovalStatus | "not_found";

export interface ApprovalSizeMessage {
  type: "allowance:approval-size";
  id: string;
  height: number;
}
export interface ApprovalStatusMessage {
  type: "allowance:approval";
  id: string;
  status: Exclude<ApprovalStatus, "pending">;
}

export const sizeMessage = (id: string, height: number): ApprovalSizeMessage => ({ type: "allowance:approval-size", id, height: Math.ceil(height) });
export const statusMessage = (id: string, status: ApprovalStatusMessage["status"]): ApprovalStatusMessage => ({ type: "allowance:approval", id, status });

/**
 * The status to announce to the chat: approved / denied / expired, once final. Nothing while
 * pending, and nothing for an unknown id (the chat would read any status as a decision).
 */
export function announceableStatus(status: EmbedStatus | undefined): ApprovalStatusMessage["status"] | null {
  return status === "approved" || status === "denied" || status === "expired" ? status : null;
}

export function postToParent(msg: ApprovalSizeMessage | ApprovalStatusMessage) {
  // "*" per §13.5: the message carries no secrets (an id and a status), and the chat page's origin
  // can be localhost or 127.0.0.1. Framing itself is limited by CSP frame-ancestors.
  if (typeof window !== "undefined" && window.parent) window.parent.postMessage(msg, "*");
}
