import { err, ok } from "neverthrow";
import type { Failure, Outcome } from "./domain/errors.ts";

function hostFailure(cause: unknown, kind: "host" | "persistence"): Failure {
  // Pi/Node I/O rejects with plain Error; custom error classes and unknown values are not assumed operational.
  if (typeof cause === "string") return { kind, message: cause, cause };
  if (
    (cause instanceof Error && cause.constructor === Error) ||
    (cause instanceof DOMException && cause.name === "AbortError")
  ) {
    return { kind, message: cause.message, cause };
  }
  // oxlint-disable-next-line mentor/no-direct-throw -- Preserve unexpected defects, never disguise them as user rejection.
  throw cause;
}
export function hostCall<T>(effect: () => T, kind: "host" | "persistence" = "host"): Outcome<T> {
  try {
    return ok(effect());
  } catch (cause) {
    return err(hostFailure(cause, kind));
  }
}
export async function hostAsync<T>(effect: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return ok(await effect());
  } catch (cause) {
    return err(hostFailure(cause, "host"));
  }
}
