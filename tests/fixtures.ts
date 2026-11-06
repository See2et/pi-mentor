import { expectOk } from "./result.ts";
import { initialState } from "../src/domain/state.ts";
import { applyUser } from "../src/domain/workflow.ts";
import type { Contract, Observation } from "../src/domain/work-unit.ts";

export function designSetup() {
  let s = expectOk(applyUser(initialState(), { type: "resume" }));
  s = expectOk(applyUser(s, { type: "issue", text: "入力検証" }));
  s = expectOk(applyUser(s, { type: "select", issueId: 1 }));
  return expectOk(
    applyUser(s, { type: "hypothesis", issueId: 1, text: "Validate at the boundary" }),
  );
}
export const contract: Contract = {
  kind: "feature",
  title: "入力境界",
  purpose: "不正入力を拒否する",
  designRefs: ["issue #1 r1 / API仕様"],
  scope: "入力処理",
  expectations: [{ id: "E1", text: "長すぎる入力を拒否する" }],
  nonGoals: "UI変更",
  verificationPlan: "境界入力を実際に送る",
};
export const source: Observation = {
  checkedAt: "now",
  source: { hash: "a".repeat(64), root: "/repo", checkedAt: "now" },
};
export const changed: Observation = {
  checkedAt: "later",
  source: { hash: "b".repeat(64), root: "/repo", checkedAt: "later" },
};
export function unitSetup() {
  let s = expectOk(applyUser(initialState(), { type: "resume" }));
  s = expectOk(applyUser(s, { type: "phase", whole: "implementation" }));
  s = expectOk(applyUser(s, { type: "unitContract", contract }));
  return expectOk(applyUser(s, { type: "selectUnit", unitId: 1 }));
}
export const evidence = {
  type: "unitEvidence" as const,
  unitId: 1,
  revision: 1,
  sourceHash: source.source!.hash,
  entries: [
    {
      expectationId: "E1",
      observation: "長すぎる入力が拒否された",
      references: ["node check.ts; exit 0"],
      method: "real" as const,
      limitations: "本番依存は未確認",
    },
  ],
  concerns: "本番依存の挙動は未知",
};
