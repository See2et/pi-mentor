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
export function validState(data: unknown): data is State {
  return Value.Check(StateSchema, data) && validUnits(data) && validDesign(data);
}
