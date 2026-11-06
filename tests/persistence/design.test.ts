import { expectOk } from "../result.ts";
import { test } from "vitest";
import assert from "node:assert/strict";
import { applyUser } from "../../src/domain/workflow.ts";
import { restore } from "../../src/persistence.ts";

import { designSetup as setup } from "../fixtures.ts";

test("active branch restores last valid snapshot and refuses unsupported/corrupt snapshots", () => {
  const a = setup();
  const b = expectOk(applyUser(a, { type: "phase", whole: "summary" }));
  const entry = (data: unknown) => ({ type: "custom", customType: "mentor-state", data });
  assert.equal(restore([entry(a)]).state.whole, "goals");
  assert.equal(restore([entry(a), entry(b)]).state.whole, "summary");
  assert.match(restore([entry(a), entry({ ...b, schema: 9 })]).error!, /unsupported|invalid/);
  assert.equal(restore([entry(a), entry({ ...b, schema: 9 })]).state.whole, "goals");
  assert.equal(restore([]).state.enabled, false);
});
