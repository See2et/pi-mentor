import { expectOk } from "../result.ts";
import { test } from "vitest";
import assert from "node:assert/strict";
import { applyUser, applyModel } from "../../src/domain/workflow.ts";
import { restore } from "../../src/persistence.ts";
import { location, mentorContext, compactRecord } from "../../src/presentation/record.ts";

import { designSetup as setup } from "../fixtures.ts";

test("projection retains active current concerns and exposes other pending decisions without history growth", () => {
  let s = setup();
  s = expectOk(applyUser(s, { type: "phase", whole: "explore", inner: "critique" }));
  s = expectOk(
    applyModel(s, {
      type: "critique",
      issueId: 1,
      revision: 1,
      category: "uncertainty",
      text: "Current concern",
      evidence: "Concrete condition",
      status: "open",
    }),
  );
  s = expectOk(applyUser(s, { type: "issue", text: "Other issue" }));
  s = expectOk(applyUser(s, { type: "hypothesis", issueId: 2, text: "Other current hypothesis" }));
  s = expectOk(applyModel(s, { type: "draft", issueId: 2, text: "Pending alternative" }));
  const before = JSON.stringify(compactRecord(s)).length;
  for (let n = 0; n < 40; n++) {
    s = expectOk(
      applyModel(s, {
        type: "response",
        issueId: 2,
        revision: 1,
        text: "Historical response ".repeat(100),
      }),
    );
    s = expectOk(
      applyUser(s, {
        type: "judge",
        issueId: 2,
        decision: "defer",
        note: "Historical note ".repeat(100),
      }),
    );
  }
  const projected = compactRecord(s);
  assert.equal(projected.issues[0].concerns?.[0].text, "Current concern");
  assert.deepEqual(projected.issues[1].pendingDrafts, [2]);
  assert.equal(projected.issues[1].judgment?.decision, "defer");
  assert.ok(JSON.stringify(projected).length - before < 500);
  assert.ok(projected.omitted.length);
  const consistency = compactRecord({ ...s, whole: "consistency" });
  assert.equal(consistency.issues[1].current?.text, "Other current hypothesis");
  assert.equal(s.issues[1].responses.length, 40, "projection never mutates history");
});

test("UI and model context share the same current location, including restored branch", () => {
  const s = setup();
  const restored = restore([{ type: "custom", customType: "mentor-state", data: s }]).state;
  for (const line of location(restored)) assert.ok(mentorContext(restored)?.includes(line));
  assert.match(mentorContext(restored)!, /only the user/i);
});
