import assert from "node:assert/strict";
import { test } from "vitest";
import { discussionView, initialState, validState } from "../../src/domain/state.ts";
import {
  applyDiscussion,
  applyModel,
  applyUser,
  currentNext,
  proposeNext,
  transition,
} from "../../src/domain/workflow.ts";
import { pendingNext } from "../../src/domain/approval.ts";
import { unitJudgment } from "../../src/domain/work-unit.ts";
import type { Edge, Next } from "../../src/domain/workflow-schema.ts";
import { restore } from "../../src/persistence.ts";
import { exactArtifact } from "../../src/presentation/action.ts";
import { changed, contract, source } from "../fixtures.ts";
import { expectError, expectOk } from "../result.ts";

const next = (edge: Edge): Next => ({ summary: "会話の次の一手", unresolved: "", edge });
function discussion() {
  let s = expectOk(applyUser(initialState(), { type: "resume" }));
  s = expectOk(applyDiscussion(s, { type: "goals", goal: "入力を安全に扱う", constraints: "" }));
  s = expectOk(applyDiscussion(s, { type: "issue", text: "入力境界" }));
  return expectOk(applyDiscussion(s, { type: "target", text: "利用者の仮説A" }));
}

test("mode proposals never apply themselves; selection is reversible and sequence/source bound", () => {
  const s = discussion();
  assert.equal(
    s.issues[0].inner,
    "hypothesis",
    "recording a target must not switch educational mode",
  );
  assert.equal(discussionView(s).mode, "hypothesis");
  expectError(applyDiscussion(s, { type: "direction" }), /mode|approval/i);
  const proposed = expectOk(proposeNext(s, next({ type: "critique" }), source));
  assert.equal(discussionView(proposed).mode, "hypothesis");
  assert.equal(pendingNext(proposed, changed), undefined);
  const stale = expectOk(applyModel(proposed, { type: "proposal", text: "追加の記録" }));
  assert.equal(pendingNext(stale, source), undefined);
  const selected = expectOk(transition(proposed, pendingNext(proposed, source)!, source));
  assert.equal(discussionView(selected).mode, "critique");
  assert.equal(
    discussionView(expectOk(transition(selected, next({ type: "hypothesis" }), source))).mode,
    "hypothesis",
  );
});

test("one discussion retains hypotheses A/B, related issue C and revision-bound history across modes", () => {
  let s = expectOk(transition(discussion(), next({ type: "critique" }), source));
  s = expectOk(
    applyModel(s, {
      type: "critique",
      issueId: 1,
      revision: 1,
      category: "uncertainty",
      text: "Aの前提",
      evidence: "境界の条件",
      status: "open",
    }),
  );
  s = expectOk(applyUser(s, { type: "judge", issueId: 1, decision: "defer", note: "比較する" }));
  const old = structuredClone(s.issues[0]);
  s = expectOk(applyDiscussion(s, { type: "target", text: "利用者の仮説B" }));
  s = expectOk(applyDiscussion(s, { type: "issue", text: "関連する論点C" }));
  assert.equal(
    discussionView(s).mode,
    "critique",
    "organizing a related issue cannot silently change mode",
  );
  s = expectOk(transition(s, next({ type: "hypothesis" }), source));
  s = expectOk(applyDiscussion(s, { type: "focus", issueId: 1, revision: 1 }));
  assert.equal(discussionView(s).mode, "hypothesis");
  assert.deepEqual(discussionView(s).targets, [
    { issueId: 1, revision: null },
    { issueId: 1, revision: 1 },
    { issueId: 1, revision: 2 },
    { issueId: 2, revision: null },
  ]);
  assert.deepEqual(s.issues[0].critiques, old.critiques);
  assert.deepEqual(s.issues[0].judgments, old.judgments);
  assert.equal(s.issues[0].revisions.length, 2);
  assert.equal(
    s.issues[0].currentRevision,
    2,
    "historical focus cannot revive an old judgment as current",
  );
  assert.deepEqual(discussionView(s).focus, { issueId: 1, revision: 1 });
  assert.match(expectOk(exactArtifact(s, next({ type: "critique" }), source)), /利用者の仮説A/);
  assert.equal(s.discussionHistory?.at(-1)?.action.type, "focus");
  assert.ok(validState(s));
  assert.equal(
    validState({
      ...s,
      discussion: { ...discussionView(s), targets: [{ issueId: 1, revision: 99 }] },
    }),
    false,
  );
});

test("one exact start approval from discussion authorizes only a new contract; accept returns to discussion without authority", () => {
  let s = discussion();
  const start = next({ type: "start", contract });
  assert.match(expectOk(exactArtifact(s, start, source)), /入力処理/);
  const proposed = expectOk(proposeNext(s, start, source));
  assert.equal(proposed.units.length, 0);
  s = expectOk(transition(proposed, start, source));
  assert.equal(s.whole, "implementation");
  assert.equal(s.units[0].phase, "implementing");
  assert.deepEqual(s.units[0].revisions[0].contract, contract);
  assert.equal(s.issues[0].judgments.length, 0, "no preliminary adoption needed");
  s = expectOk(transition(s, next({ type: "inspect" }), source));
  s = expectOk(transition(s, next({ type: "accept", note: "限界を留保" }), source));
  assert.equal(s.whole, "issues");
  assert.equal(s.units[0].phase, "judgment");
  assert.notEqual(currentNext(s, source)?.edge.type, "review");
  assert.equal(unitJudgment(s.units[0], changed), undefined);
  expectError(transition(s, next({ type: "correct", note: "" }), source), /implementation/);
  s = expectOk(applyDiscussion(s, { type: "issue", text: "次の問い" }));
  expectError(transition(s, next({ type: "start" }), source), /exact|scope/i);
  const old = s.units[0];
  s = expectOk(transition(s, start, source));
  assert.equal(s.units.length, 2);
  assert.deepEqual(s.units[0], old, "new work never revives accepted unit");
});

test("legacy schema 2 derives a discussion without rewriting histories or refreshing pending proposals", () => {
  const modern = expectOk(proposeNext(discussion(), next({ type: "critique" }), source));
  const { discussion: _discussion, ...legacy } = modern;
  const entry = { type: "custom", customType: "mentor-state", data: legacy };
  const restored = restore([entry]);
  assert.equal(restored.error, undefined);
  assert.deepEqual(restored.state, legacy);
  assert.equal(discussionView(restored.state).mode, "hypothesis");
  assert.deepEqual(pendingNext(restored.state, source)?.edge, { type: "critique" });
  assert.equal(pendingNext(restored.state, changed), undefined);
  const moved = expectOk(transition(restored.state, next({ type: "critique" }), source));
  assert.deepEqual(moved.issues[0].revisions, legacy.issues[0].revisions);
  assert.ok(validState(moved));
});
