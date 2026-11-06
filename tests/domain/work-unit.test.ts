import { expectOk, expectError } from "../result.ts";
import { test } from "vitest";
import assert from "node:assert/strict";
import { initialState } from "../../src/domain/state.ts";
import { applyUser, applyModel } from "../../src/domain/workflow.ts";

import { location, mentorContext, compactRecord } from "../../src/presentation/record.ts";
import { unitJudgment, evidenceFreshness, type Observation } from "../../src/domain/work-unit.ts";
import { unitDetails } from "../../src/presentation/unit.ts";
import { widgetLines } from "../../src/widget.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

import { contract, source, changed, unitSetup as setup, evidence } from "../fixtures.ts";

test("implementation is a human-selectable whole activity, independent of design completion", () => {
  const s = expectOk(
    applyUser(expectOk(applyUser(initialState(), { type: "resume" })), {
      type: "phase",
      whole: "implementation",
    }),
  );
  assert.equal(s.whole, "implementation");
});
test("AI drafts cannot select or start a unit; exact human confirmation binds a contract, not a judgment", () => {
  let s = expectOk(applyUser(initialState(), { type: "resume" }));
  s = expectOk(applyModel(s, { type: "unitDraft", contract }));
  assert.equal(s.activeUnit, null);
  assert.equal(s.units[0].currentRevision, null);
  for (const type of ["unitJudge", "unitPhase", "confirmUnit", "selectUnit"])
    expectError(applyModel(s, { type, unitId: 1 } as never), /not permitted/);
  s = expectOk(applyUser(s, { type: "selectUnit", unitId: 1 }));
  s = expectOk(applyUser(s, { type: "phase", whole: "implementation" }));
  expectError(
    applyUser(s, { type: "unitPhase", unitId: 1, phase: "implementing" }),
    /Confirm/,
    "authority",
  );
  s = expectOk(applyUser(s, { type: "confirmUnit", unitId: 1, revision: 1 }));
  assert.equal(s.units[0].phase, "scope");
  assert.equal(s.units[0].judgments.length, 0);
});
test("evidence binds valid expectation IDs, contract revision and observed code; ready/test results never advance phase or decide", () => {
  let s = setup();
  expectError(applyModel(s, evidence), /snapshot/);
  expectError(applyModel(s, evidence, changed), /snapshot/, "freshness");
  expectError(
    applyModel(
      s,
      { ...evidence, entries: [{ ...evidence.entries[0], expectationId: "E99" }] },
      source,
    ),
    /expectation IDs/,
  );
  s = expectOk(applyModel(s, evidence, source));
  s = expectOk(
    applyModel(s, {
      type: "unitReport",
      unitId: 1,
      revision: 1,
      text: "準備完了・テスト成功。ただし本番未検証",
    }),
  );
  assert.equal(s.units[0].phase, "scope");
  assert.equal(s.units[0].judgments.length, 0);
  assert.match(evidenceFreshness(s.units[0], source), /最終確認時一致/);
  assert.match(evidenceFreshness(s.units[0], changed), /古い/);
  assert.match(evidenceFreshness(s.units[0]), /不明/);
  s = expectOk(
    applyUser(s, {
      type: "unitContract",
      unitId: 1,
      contract: { ...contract, expectations: [{ id: "E2", text: "空入力も拒否する" }] },
    }),
  );
  assert.equal(s.units[0].evidence.length, 1);
  assert.match(evidenceFreshness(s.units[0], source), /古い/);
  expectError(applyModel(s, evidence, source), /revision changed/);
});
test("human judgment has no evidence/understanding pass gate; revisions and source changes never inherit acceptance; corrections and notes persist", () => {
  let s = setup();
  s = expectOk(applyUser(s, { type: "unitPhase", unitId: 1, phase: "judgment" }));
  s = expectOk(
    applyUser(
      s,
      {
        type: "unitJudge",
        unitId: 1,
        decision: "accept",
        note: "証拠なし・本番は未知のまま受け入れる",
      },
      source,
    ),
  );
  assert.equal(unitJudgment(s.units[0], source)?.decision, "accept");
  assert.equal(unitJudgment(s.units[0], changed), undefined);
  assert.equal(unitJudgment(s.units[0]), undefined);
  s = expectOk(
    applyUser(
      s,
      { type: "unitJudge", unitId: 1, decision: "correction", note: "実対象の証拠がほしい" },
      changed,
    ),
  );
  s = expectOk(applyUser(s, { type: "unitPhase", unitId: 1, phase: "implementing" }));
  s = expectOk(
    applyUser(s, { type: "unitNote", unitId: 1, text: "なぜこの境界で検証するのか調べる" }),
  );
  s = expectOk(
    applyModel(s, {
      type: "unitSuggestion",
      unitId: 1,
      revision: 1,
      text: "入力経路を追ってみる提案",
    }),
  );
  s = expectOk(
    applyUser(s, {
      type: "unitContract",
      unitId: 1,
      contract: { ...contract, scope: "境界と呼出元" },
    }),
  );
  assert.equal(s.units[0].judgments.length, 2);
  assert.equal(s.units[0].notes[0].author, "human");
  assert.equal(s.units[0].notes[1].author, "ai");
  assert.equal(s.units[0].phase, "scope");
  assert.equal(unitJudgment(s.units[0], source), undefined);
  assert.match(location(s, source).join("\n"), /未判断/);
  assert.match(mentorContext(s, source)!, /never automatic expectation satisfaction/);
});
test("experiment acceptance is not design adoption, defer needs no implementation, return to design is explicitly human", () => {
  let s = setup();
  s = expectOk(
    applyUser(s, {
      type: "unitContract",
      unitId: 1,
      contract: { ...contract, kind: "experiment" },
    }),
  );
  s = expectOk(applyUser(s, { type: "unitPhase", unitId: 1, phase: "judgment" }));
  s = expectOk(applyUser(s, { type: "unitJudge", unitId: 1, decision: "defer", note: "" }));
  assert.equal(s.whole, "implementation");
  assert.equal(s.units[0].judgments[0].source, null);
  s = expectOk(
    applyUser(s, { type: "unitJudge", unitId: 1, decision: "accept", note: "" }, source),
  );
  assert.equal(s.issues.length, 0);
  assert.equal(s.units[0].phase, "judgment");
  s = expectOk(
    applyUser(
      s,
      { type: "unitJudge", unitId: 1, decision: "design", note: "前提を再検討する" },
      source,
    ),
  );
  assert.equal(s.whole, "issues");
  assert.equal(s.activeUnit, 1);
  assert.equal(s.units[0].judgments.length, 3);
});
test("latest human judgment is never bypassed when source observation returns", () => {
  const unavailable: Observation = { checkedAt: "offline", error: "Git unavailable" };
  for (const decision of ["correction", "defer"] as const) {
    for (const laterSource of [unavailable, changed]) {
      let s = expectOk(applyUser(setup(), { type: "unitPhase", unitId: 1, phase: "judgment" }));
      s = expectOk(
        applyUser(s, { type: "unitJudge", unitId: 1, decision: "accept", note: "At A" }, source),
      );
      s = expectOk(
        applyUser(
          s,
          { type: "unitJudge", unitId: 1, decision, note: "Latest human choice" },
          laterSource,
        ),
      );
      assert.equal(unitJudgment(s.units[0], source), undefined, "Do not resurrect acceptance at A");
      const record = compactRecord(s, source).units[0];
      assert.equal(record.judgment, undefined);
      assert.equal(record.latestJudgment?.decision, decision);
      assert.match(record.judgmentStatus, laterSource.source ? /不一致/ : /不明/);
      const display = location(s, source).join("\n");
      assert.match(display, decision === "correction" ? /修正を依頼する/ : /保留する/);
      assert.doesNotMatch(display, /このスコープを受け入れる/);
      assert.ok(mentorContext(s, source)!.includes(record.judgmentStatus));
      assert.ok(unitDetails(s.units[0], source).includes(record.judgmentStatus));
      assert.match(
        widgetLines(s, 120, undefined, source).join(""),
        /結果の判断 → 結果の再検討/,
        "compact phase widget must not suggest whole review from an older acceptance",
      );
      for (const line of widgetLines(s, 36, undefined, source)) assert.ok(visibleWidth(line) <= 36);
      assert.equal(s.units[0].judgments.length, 2);
    }
  }
});
