import { err, type Result } from "neverthrow";

export type FailureKind =
  | "invalid-input"
  | "missing-target"
  | "authority"
  | "freshness"
  | "cancelled"
  | "host"
  | "persistence";
export type Failure = {
  readonly kind: FailureKind;
  readonly message: string;
  readonly cause?: unknown;
};
export type Outcome<T> = Result<T, Failure>;
export const reject = (message: string, kind: FailureKind = "invalid-input") =>
  err<never, Failure>({ kind, message });
