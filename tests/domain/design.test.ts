import { expectOk, expectError } from "../result.ts";
import { test } from "vitest";
import assert from "node:assert/strict";
import { applyUser, applyModel } from "../../src/domain/workflow.ts";
import { location, mentorContext, hintPrompt } from "../../src/presentation/record.ts";

import { designSetup as setup } from "../fixtures.ts";

test("record-only model writes cannot select phases or decisions; proposals are not adoption", () => {
  const s = setup();
  const proposed = expectOk(applyModel(s, { type: "proposal", text: "Adopt and move to summary" }));
  assert.equal(proposed.whole, "goals");
  assert.equal(proposed.issues[0].judgments.length, 0);
  expectError(applyModel(s, { type: "phase", whole: "summary" } as never), /not permitted/);
  expectError(applyModel(s, { type: "judge", decision: "adopt" } as never), /not permitted/);
  const moved = expectOk(
    applyUser(proposed, { type: "phase", whole: "explore", inner: "judgment" }),
  );
  const judged = expectOk(
    applyUser(moved, { type: "judge", issueId: 1, decision: "adopt", note: "For now" }),
  );
  assert.equal(judged.issues[0].judgments[0].revision, 1);
  assert.equal(expectOk(applyUser(judged, { type: "phase", whole: "issues" })).whole, "issues");
});

test("record-only drafts cannot replace current revision; new revisions do not inherit judgment or criticism", () => {
  let s = setup();
  s = expectOk(
    applyModel(s, {
      type: "critique",
      issueId: 1,
      revision: 1,
      category: "security",
      text: "Missing length bound",
      evidence: "Unbounded input reaches parser",
      status: "open",
    }),
  );
  s = expectOk(applyUser(s, { type: "judge", issueId: 1, decision: "adopt", note: "Accept risk" }));
  s = expectOk(applyModel(s, { type: "draft", issueId: 1, text: "Bound size too" }));
  assert.equal(s.issues[0].currentRevision, 1);
  s = expectOk(applyUser(s, { type: "confirmDraft", issueId: 1, revision: 2 }));
  assert.equal(s.issues[0].currentRevision, 2);
  assert.match(location(s).join(" "), /未判断/);
  assert.equal(s.issues[0].judgments[0].revision, 1);
  assert.equal(s.issues[0].critiques[0].revision, 1);
  expectError(
    applyModel(s, {
      type: "critique",
      issueId: 1,
      revision: 2,
      replaces: 1,
      category: "security",
      text: "Withdraw",
      evidence: "Updated",
      status: "withdrawn",
    }),
    /same revision/,
  );
});

test("pause rejects model mutation, hints are immediate requests without phase changes", () => {
  const s = setup();
  for (const kind of ["decompose", "perspective", "knowledge", "example", "partial"] as const) {
    assert.match(expectOk(hintPrompt(s, kind)), /this response only/);
    assert.equal(s.whole, "goals");
  }
  const paused = expectOk(applyUser(s, { type: "pause" }));
  assert.equal(mentorContext(paused), undefined);
  expectError(applyModel(paused, { type: "proposal", text: "change" }), /paused/);
  expectError(hintPrompt(paused, "example"), /paused/);
});
