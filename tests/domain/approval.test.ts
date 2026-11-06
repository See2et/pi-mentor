import { expectOk, expectError } from "../result.ts";
import { test } from "vitest";
import assert from "node:assert/strict";
import {
  pendingNext,
  requireApprovalAvailable,
  requireApprovalCurrent,
  requireFreshIntent,
} from "../../src/domain/approval.ts";
import { applyUser, currentNext, proposeNext } from "../../src/domain/workflow.ts";
import { restore } from "../../src/persistence.ts";
import { designSetup, source, changed } from "../fixtures.ts";

test("pending approval binds record and source identity; a stale offer never falls back to a different default", () => {
  const s = expectOk(
    applyUser(designSetup(), { type: "phase", whole: "explore", inner: "critique" }),
  );
  const offered = expectOk(
    proposeNext(s, { summary: "会話から整理", unresolved: "", edge: { type: "decide" } }, source),
  );
  assert.ok(pendingNext(offered, source));
  assert.equal(pendingNext(offered, changed), undefined);
  assert.equal(
    pendingNext(offered, { ...source, source: { ...source.source!, root: "/other-repo" } }),
    undefined,
  );
  const updated = expectOk(
    applyUser(offered, { type: "response", issueId: 1, text: "別の条件がある" }),
  );
  assert.equal(
    currentNext(updated, source),
    undefined,
    "stale proposal is not replaced with a different default action",
  );
  assert.deepEqual(
    restore([{ type: "custom", customType: "mentor-state", data: offered }]).state,
    offered,
  );
});

test("native approval requires fresh intent after decline and rejects intervening host activity", () => {
  expectError(
    requireApprovalAvailable({ nativeUI: true, busy: false, aborted: true }),
    /cancelled/,
    "cancelled",
  );
  expectError(requireFreshIntent(true, 7, 7), /fresh explicit user intent/);
  expectOk(requireFreshIntent(true, 8, 7));
  const candidate = { inputVersion: 8, activity: 2, inFlight: false, leaf: "leaf" };
  expectOk(requireApprovalCurrent(candidate, { ...candidate }));
  expectError(
    requireApprovalCurrent(candidate, { ...candidate, activity: 3 }),
    /tool activity changed/,
  );
});
