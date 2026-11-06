import { expectOk } from "../result.ts";
import { test } from "vitest";
import assert from "node:assert/strict";
import { initialState } from "../../src/domain/state.ts";
import { applyUser } from "../../src/domain/workflow.ts";
import type { Contract, Observation } from "../../src/domain/work-unit.ts";

const contract: Contract = {
  kind: "feature",
  title: "Boundary",
  purpose: "Validate input",
  designRefs: ["API"],
  scope: "Parser",
  expectations: [{ id: "E1", text: "Reject oversized input" }],
  nonGoals: "UI",
  verificationPlan: "Send oversized input",
};

test("judgment owns its observed source; later adapter changes cannot rewrite its binding", () => {
  const observation: Observation = {
    checkedAt: "now",
    source: { hash: "a".repeat(64), root: "/repo", checkedAt: "now" },
  };
  let s = expectOk(applyUser(initialState(), { type: "resume" }));
  s = expectOk(applyUser(s, { type: "phase", whole: "implementation" }));
  s = expectOk(applyUser(s, { type: "unitContract", contract }));
  s = expectOk(applyUser(s, { type: "selectUnit", unitId: 1 }));
  s = expectOk(applyUser(s, { type: "unitPhase", unitId: 1, phase: "judgment" }));
  const before = structuredClone(s);
  const judged = expectOk(
    applyUser(s, { type: "unitJudge", unitId: 1, decision: "accept", note: "" }, observation),
  );
  observation.source!.hash = "b".repeat(64);
  assert.equal(judged.units[0].judgments[0].source?.hash, "a".repeat(64));
  assert.deepEqual(s, before, "transition never modifies its input");
});
