import { ok, safeTry } from "neverthrow";
import type { Outcome } from "./errors.ts";
import type { State } from "./state.ts";
import { copy, requireRule } from "./value.ts";
import type { Observation } from "./work-unit.ts";
import type { Next } from "./workflow-schema.ts";

export const sourceIdentity = (o?: Observation) =>
  o?.source ? `${o.source.root}:${o.source.hash}` : `unknown:${o?.error ?? "not observed"}`;
export const snapshotToken = (
  session: string,
  epoch: number,
  sequence: number,
  observation?: Observation,
) => `${session}/${epoch}/${sequence}:${sourceIdentity(observation)}`;
export function requireSnapshot(expected: string, current: string): Outcome<void> {
  return requireRule(
    expected === current,
    "Mentor state changed while this operation was open. No change applied; reopen /mentor or refresh mentor_status.",
    "freshness",
  );
}
export function boundNext(sequence: number, proposal: Next, observation?: Observation) {
  return { sequence, source: sourceIdentity(observation), proposal: copy(proposal) };
}
export function pendingNext(s: State, o?: Observation): Next | undefined {
  const p = s.guided?.pending;
  if (!p || p.sequence !== s.sequence || p.source !== sourceIdentity(o)) return undefined;
  return p.proposal;
}

// The adapter observes host activity; these facts decide whether this exact one-time offer remains valid.
export type ApprovalActivity = {
  readonly inputVersion: number;
  readonly activity: number;
  readonly inFlight: boolean;
  readonly leaf: string | null;
};
export function requireApprovalAvailable(facts: {
  nativeUI: boolean;
  busy: boolean;
  aborted: boolean;
}): Outcome<void> {
  return safeTry(function* () {
    yield* requireRule(
      facts.nativeUI,
      "Native Mentor approval requires interactive TUI; no change applied.",
    );
    yield* requireRule(
      !facts.busy,
      "Mentor approval or other tool activity is busy; no change applied.",
    );
    yield* requireRule(
      !facts.aborted,
      "Mentor assistance cancelled; no change applied.",
      "cancelled",
    );
    return ok(undefined);
  });
}
export function requireFreshIntent(
  hasInput: boolean,
  version: number,
  declinedVersion?: number,
): Outcome<void> {
  return safeTry(function* () {
    yield* requireRule(
      hasInput,
      "No host-observed real user input for this request; no change applied.",
    );
    yield* requireRule(
      declinedVersion !== version,
      "Mentor approval was cancelled or rejected on this input. Wait for fresh explicit user intent before offering it again.",
    );
    return ok(undefined);
  });
}
export function requireApprovalCurrent(
  candidate: ApprovalActivity,
  current: ApprovalActivity,
): Outcome<void> {
  return requireRule(
    candidate.inputVersion === current.inputVersion &&
      candidate.activity === current.activity &&
      !current.inFlight &&
      candidate.leaf === current.leaf,
    "Request, branch or tool activity changed during approval; no change applied.",
    "freshness",
  );
}
