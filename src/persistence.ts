import { initialState, validState, type State } from "./domain/state.ts";

export function restore(entries: readonly unknown[]): { state: State; error?: string } {
  let state = initialState();
  let error: string | undefined;
  for (const value of entries) {
    const entry = value as { type?: string; customType?: string; data?: unknown };
    if (entry.type !== "custom" || entry.customType !== "mentor-state") continue;
    const raw = entry.data as Record<string, unknown> | null;
    // Schema 1 had no implementation records; retain all design/history fields.
    const data =
      raw &&
      raw.schema === 1 &&
      raw.whole !== "implementation" &&
      !("units" in raw) &&
      !("activeUnit" in raw)
        ? { ...raw, schema: 2, activeUnit: null, units: [] }
        : raw;
    if (!validState(data)) {
      error =
        "Mentor snapshot is invalid or unsupported; changes blocked. Inspect session data or explicitly reset from /mentor.";
      continue;
    }
    state = structuredClone(data);
    error = undefined;
  }
  return { state, error };
}
