import { expectOk } from "../result.ts";
import { test } from "vitest";
import assert from "node:assert/strict";
import { initialState } from "../../src/domain/state.ts";
import { applyUser, applyModel } from "../../src/domain/workflow.ts";
import { mentorContext, compactRecord } from "../../src/presentation/record.ts";
import { contract, source, unitSetup as setup, evidence } from "../fixtures.ts";

test("unit projections keep exact current contracts and evidence while non-current history stays summarized", () => {
  let s = setup();
  const longScope = "Current exact scope ".repeat(250);
  s = expectOk(
    applyUser(s, { type: "unitContract", unitId: 1, contract: { ...contract, scope: longScope } }),
  );
  for (let n = 0; n < 5; n++)
    s = expectOk(
      applyModel(s, { ...evidence, revision: 2, concerns: `Unresolved concern ${n}` }, source),
    );
  s = expectOk(
    applyUser(s, { type: "unitContract", contract: { ...contract, title: "Other unit" } }),
  );
  const before = JSON.stringify(compactRecord(s, source)).length;
  s = expectOk(applyUser(s, { type: "selectUnit", unitId: 2 }));
  for (let n = 0; n < 40; n++)
    s = expectOk(
      applyModel(s, {
        type: "unitReport",
        unitId: 2,
        revision: 1,
        text: "Old non-current report ".repeat(150),
      }),
    );
  s = expectOk(applyUser(s, { type: "selectUnit", unitId: 1 }));
  const projection = compactRecord(s, source);
  assert.equal(projection.units[0].current?.contract.scope, longScope);
  assert.equal(
    projection.units[0].evidence?.length,
    5,
    "all current-contract concerns survive, not a last-N slice",
  );
  assert.equal(projection.units[1].reports, undefined);
  assert.ok(JSON.stringify(projection).length - before < 100);
  assert.equal(s.units[1].reports.length, 40);
});

test("operative unit guidance distinguishes confirmation, explicit start, examination and judgment", () => {
  const operative = (s: ReturnType<typeof initialState>) =>
    mentorContext(s, source)!.split("AT THIS PHASE: ")[1].split("\nCURRENT LOCATION")[0];
  let s = expectOk(
    applyUser(expectOk(applyUser(initialState(), { type: "resume" })), {
      type: "phase",
      whole: "implementation",
    }),
  );
  assert.match(operative(s), /No active unit/);
  s = expectOk(applyModel(s, { type: "unitDraft", contract }));
  s = expectOk(applyUser(s, { type: "selectUnit", unitId: 1 }));
  s = expectOk(applyUser(s, { type: "confirmUnit", unitId: 1, revision: 1 }));
  assert.equal(s.units[0].phase, "scope");
  assert.match(operative(s), /Contract confirmation is not implementation authorization/);
  assert.match(operative(s), /explicitly start/);
  s = expectOk(applyUser(s, { type: "unitPhase", unitId: 1, phase: "implementing" }));
  assert.match(operative(s), /Use normal Pi tools to implement and check/);
  assert.match(operative(s), /Do not start another unit/);
  for (const phase of ["examination", "judgment"] as const) {
    s = expectOk(applyUser(s, { type: "unitPhase", unitId: 1, phase }));
    assert.match(operative(s), /Do not continue implementation/);
    assert.match(
      operative(s),
      phase === "examination" ? /Inspect observations/ : /Support the human decision/,
    );
    assert.doesNotMatch(operative(s), /Use normal Pi tools to implement and check/);
  }
});
