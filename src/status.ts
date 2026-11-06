import { ok, safeTry } from "neverthrow";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { issueById } from "./domain/design.ts";
import { reject } from "./domain/errors.ts";
import type { State } from "./domain/state.ts";
import { unitById, type Observation } from "./domain/work-unit.ts";
import { compactRecord } from "./presentation/record.ts";

const id = Type.Integer({ minimum: 1 });
export const StatusSchema = Type.Union([
  Type.Object({ view: Type.Optional(Type.Literal("current")) }, { additionalProperties: false }),
  Type.Object({ view: Type.Literal("issue"), issueId: id }, { additionalProperties: false }),
  Type.Object({ view: Type.Literal("unit"), unitId: id }, { additionalProperties: false }),
  Type.Object({ view: Type.Literal("full") }, { additionalProperties: false }),
]);
export const statusRecovery =
  'Via codemode: mentor_status({}) for current; {view:"issue",issueId:N} or {view:"unit",unitId:N} for complete target history; {view:"full"} for all branch history including proposals, discussion and card history. Discover IDs in current.';
export function statusView(s: State, query: Static<typeof StatusSchema>, observation: Observation) {
  return safeTry(function* () {
    if (!Value.Check(StatusSchema, query))
      return reject(
        "Invalid status query: use current, issue with issueId, unit with unitId, or explicit full.",
      );
    const view = query.view ?? "current";
    switch (query.view) {
      case "full":
        return ok({ view, record: s, omitted: [], recovery: statusRecovery });
      case "issue":
        return ok({
          view,
          record: { issue: yield* issueById(s, query.issueId) },
          omitted: ["Other targets and global history"],
          recovery: statusRecovery,
        });
      case "unit":
        return ok({
          view,
          record: { unit: yield* unitById(s, query.unitId) },
          omitted: ["Other targets and global history"],
          recovery: statusRecovery,
        });
      default:
        return ok({
          view,
          record: compactRecord(s, observation),
          omitted: [
            "Historical revisions, critiques, responses, evidence, judgments and discussion/card history; non-current targets are summaries, not complete records",
          ],
          recovery: statusRecovery,
        });
    }
  });
}
