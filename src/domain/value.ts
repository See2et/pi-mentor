import { ok } from "neverthrow";
import { reject, type FailureKind, type Outcome } from "./errors.ts";

export type ReadonlyValue<T> = T extends object
  ? { readonly [K in keyof T]: ReadonlyValue<T[K]> }
  : T;
type MutableValue<T> = T extends object ? { -readonly [K in keyof T]: MutableValue<T[K]> } : T;

// Every transition owns its working copy; published state and query results are readonly.
export const copy = <T>(value: T): MutableValue<T> => structuredClone(value) as MutableValue<T>;
export function requireRule(
  condition: unknown,
  message: string,
  kind: FailureKind = "authority",
): Outcome<void> {
  return condition ? ok(undefined) : reject(message, kind);
}
export function requireActive(s: { readonly enabled: boolean }): Outcome<void> {
  return requireRule(s.enabled, "Mentor is paused. Only the user can resume with /mentor.");
}
export function content(value: string, empty = false): Outcome<string> {
  const result = value.trim();
  if ((!empty && !result) || result.length > 6000)
    return reject("Text must be 1–6000 characters (goal/constraints may be empty).");
  return ok(result);
}
