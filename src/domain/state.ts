import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { DiscussionActionSchema, IssueSchema, validDesign } from "./design.ts";
import type { ReadonlyValue } from "./value.ts";
import { UnitSchema, validUnits } from "./work-unit.ts";
import { GuidedSchema } from "./workflow-schema.ts";

export const WHOLE = {
  goals: "全体目標・制約",
  issues: "論点の洗い出し",
  explore: "論点の検討",
  consistency: "全体整合性",
  summary: "まとめ",
  implementation: "実装・検証",
} as const;
const whole = Type.Unsafe<keyof typeof WHOLE>(
  Type.Union(Object.keys(WHOLE).map((v) => Type.Literal(v))),
);
const ref = Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]);
const DiscussionTargetSchema = Type.Object(
  { issueId: Type.Integer({ minimum: 1 }), revision: ref },
  { additionalProperties: false },
);
const DiscussionSchema = Type.Object(
  {
    mode: Type.Union([Type.Literal("hypothesis"), Type.Literal("critique")]),
    focus: Type.Union([DiscussionTargetSchema, Type.Null()]),
    targets: Type.Array(DiscussionTargetSchema),
  },
  { additionalProperties: false },
);
export const StateSchema = Type.Object(
  {
    schema: Type.Literal(2),
    sequence: Type.Integer({ minimum: 0 }),
    enabled: Type.Boolean(),
    whole,
    goal: Type.String({ maxLength: 6000 }),
    constraints: Type.String({ maxLength: 6000 }),
    activeIssue: ref,
    issues: Type.Array(IssueSchema),
    proposals: Type.Array(
      Type.Object({
        id: Type.Integer({ minimum: 1 }),
        text: Type.String({ minLength: 1, maxLength: 6000 }),
      }),
    ),
    activeUnit: ref,
    units: Type.Array(UnitSchema),
    guided: Type.Optional(GuidedSchema),
    discussion: Type.Optional(DiscussionSchema),
    discussionHistory: Type.Optional(
      Type.Array(
        Type.Object({ sequence: Type.Integer({ minimum: 0 }), action: DiscussionActionSchema }),
      ),
    ),
  },
  { additionalProperties: false },
);
export type State = ReadonlyValue<Static<typeof StateSchema>>;
export const initialState = (): State => ({
  schema: 2,
  sequence: 0,
  enabled: false,
  whole: "goals",
  goal: "",
  constraints: "",
  activeIssue: null,
  issues: [],
  proposals: [],
  activeUnit: null,
  units: [],
});
// Schema 2 snapshots without discussion retain their original data and pending freshness.
// inner is a legacy/admin view; normal conversation mode is shared across targets.
export function discussionView(s: State): NonNullable<State["discussion"]> {
  if (s.discussion) return s.discussion;
  const issue = s.issues.find((i) => i.id === s.activeIssue);
  return {
    mode: issue?.inner === "hypothesis" || !issue ? "hypothesis" : "critique",
    focus: issue ? { issueId: issue.id, revision: issue.currentRevision } : null,
    targets: issue ? [{ issueId: issue.id, revision: issue.currentRevision }] : [],
  };
}
export function focusedRevision(s: State) {
  const focus = discussionView(s).focus;
  return s.issues
    .find((i) => i.id === focus?.issueId)
    ?.revisions.find((r) => r.revision === focus?.revision);
}
export function validState(data: unknown): data is State {
  if (!Value.Check(StateSchema, data) || !validUnits(data) || !validDesign(data)) return false;
  const d = data.discussion;
  if (!d) return true;
  const keys = new Set<string>();
  for (const t of d.targets) {
    const issue = data.issues.find((i) => i.id === t.issueId);
    const key = `${t.issueId}:${t.revision}`;
    if (
      !issue ||
      (t.revision !== null && !issue.revisions.some((r) => r.revision === t.revision)) ||
      keys.has(key)
    )
      return false;
    keys.add(key);
  }
  const active = data.issues.find((i) => i.id === data.activeIssue);
  if (
    d.focus
      ? d.focus.issueId !== data.activeIssue || !keys.has(`${d.focus.issueId}:${d.focus.revision}`)
      : data.activeIssue !== null
  )
    return false;
  return (
    data.whole !== "explore" ||
    (!!active && d.mode === (active.inner === "hypothesis" ? "hypothesis" : "critique"))
  );
}
