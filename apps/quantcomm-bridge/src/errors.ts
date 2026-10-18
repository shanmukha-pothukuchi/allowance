/** Errors shared by the bridge's HTTP layer and its Quantcomm client. */

/** An API error the bridge answers with: `{ error: code, message, ...extra }`. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export type QuantcommErrorKind =
  /** Could not reach Quantcomm (refused, DNS, timeout), or it answered 5xx. */
  | "unavailable"
  /** Quantcomm answered, but not in the shape the bridge reads (fail closed). */
  | "changed";

export class QuantcommError extends Error {
  constructor(
    public kind: QuantcommErrorKind,
    message: string,
    /** What went wrong upstream, e.g. `research COF: data.panels.branch_map.nessie.n is not a number`. */
    public where?: string,
  ) {
    super(message);
    this.name = "QuantcommError";
  }
}

export const UNAVAILABLE = "Quantcomm isn't running right now; nothing was charged.";
export const UPSTREAM_FAILED = "Quantcomm couldn't build this research right now; nothing was charged.";
export const CHANGED = "Quantcomm's API changed, so the bridge can't read this research safely; nothing was charged.";

/** A shape problem at `where`: answered as `502 quantcomm_changed`. */
export const changed = (where: string) => new QuantcommError("changed", CHANGED, where);

export function isQuantcommError(err: unknown, kind?: QuantcommErrorKind): err is QuantcommError {
  return err instanceof QuantcommError && (kind === undefined || err.kind === kind);
}
