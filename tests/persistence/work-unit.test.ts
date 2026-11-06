import { expectOk } from "../result.ts";
import { test } from "vitest";
import assert from "node:assert/strict";
import { initialState } from "../../src/domain/state.ts";
import { applyUser, applyModel } from "../../src/domain/workflow.ts";
import { restore } from "../../src/persistence.ts";
import { source, unitSetup as setup, evidence } from "../fixtures.ts";

test("schema1 migration preserves design histories; current units restore; corrupt expectation bindings block mutation", () => {
  let legacy = expectOk(applyUser(initialState(), { type: "resume" }));
  legacy = expectOk(applyUser(legacy, { type: "issue", text: "既存論点" }));
  legacy = expectOk(applyUser(legacy, { type: "hypothesis", issueId: 1, text: "既存仮説" }));
  legacy = expectOk(
    applyModel(legacy, {
      type: "critique",
      issueId: 1,
      revision: 1,
      category: "uncertainty",
      text: "未確認",
      evidence: "外部条件",
      status: "open",
    }),
  );
  legacy = expectOk(
    applyUser(legacy, { type: "judge", issueId: 1, decision: "adopt", note: "留保あり" }),
  );
  const { units, activeUnit, ...old } = legacy;
  const entry = (data: unknown) => ({ type: "custom", customType: "mentor-state", data });
  const migrated = restore([entry({ ...old, schema: 1 })]);
  assert.equal(migrated.error, undefined);
  assert.deepEqual(migrated.state.issues, legacy.issues);
  assert.deepEqual(migrated.state.units, []);
  const current = expectOk(applyModel(setup(), evidence, source));
  assert.deepEqual(restore([entry(current)]).state, current);
  const corrupt = JSON.parse(JSON.stringify(current));
  corrupt.units[0].evidence[0].entries[0].expectationId = "not-a-contract-expectation";
  assert.match(restore([entry(corrupt)]).error!, /invalid/);
});
