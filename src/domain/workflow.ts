import { ok, safeTry } from "neverthrow";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { boundNext, pendingNext } from "./approval.ts";
import {
  DesignModelSchemas,
  DiscussionActionSchema,
  INNER,
  applyDesignModel,
  applyDesignUser,
  createIssue,
  currentRevision,
  discussIssue,
  issueById,
  renameIssue,
  selectInner,
  type DesignUserAction,
  type DiscussionAction,
} from "./design.ts";
import { reject, type Outcome } from "./errors.ts";
import { WHOLE, type State } from "./state.ts";
import {
  content,
  copy,
  requireRule as require,
  requireActive,
  type ReadonlyValue,
} from "./value.ts";
import {
  UnitModelSchemas,
  applyUnitModel,
  applyUnitUser,
  unitById,
  unitJudgment,
  unitRevision,
  type Observation,
  type UnitUserAction,
} from "./work-unit.ts";
import { NextSchema, type Edge, type Next } from "./workflow-schema.ts";

export type UserAction =
  | DesignUserAction
  | UnitUserAction
  | { type: "resume" | "pause" }
  | { type: "goal" | "constraints"; text: string }
  | { type: "issue"; text: string; issueId?: number }
  | { type: "select"; issueId: number }
  | { type: "phase"; whole: State["whole"]; inner?: keyof typeof INNER };
export const ModelActionSchema = Type.Union([
  ...UnitModelSchemas,
  ...DesignModelSchemas,
  Type.Object(
    { type: Type.Literal("proposal"), text: Type.String({ minLength: 1, maxLength: 6000 }) },
    { additionalProperties: false },
  ),
]);
export type ModelAction = ReadonlyValue<Static<typeof ModelActionSchema>>;

// Advanced human operations intentionally allow moves that normal cards do not.
export function applyUser(
  state: State,
  action: UserAction,
  observation?: Observation,
): Outcome<State> {
  return safeTry(function* () {
    let s = copy(state);
    if (action.type !== "resume" && action.type !== "pause") yield* requireActive(s);
    switch (action.type) {
      case "unitContract":
      case "confirmUnit":
      case "selectUnit":
      case "unitPhase":
      case "unitNote":
      case "unitJudge":
        s = { ...s, ...copy(yield* applyUnitUser(s, action, observation)) };
        // Returning to design is a human workflow decision, not experiment adoption.
        if (action.type === "unitJudge" && action.decision === "design") s.whole = "issues";
        break;
      case "resume":
        s.enabled = true;
        break;
      case "pause":
        s.enabled = false;
        break;
      case "goal":
      case "constraints":
        s[action.type] = yield* content(action.text, true);
        break;
      case "issue":
        if (action.issueId)
          s.issues[action.issueId - 1] = copy(
            yield* renameIssue(yield* issueById(s, action.issueId), action.text),
          );
        else s.issues.push(copy(yield* createIssue(s.issues.length + 1, action.text)));
        break;
      case "select":
        yield* issueById(s, action.issueId);
        s.activeIssue = action.issueId;
        break;
      case "phase":
        if (!Object.hasOwn(WHOLE, action.whole))
          return reject("Unknown whole phase", "invalid-input");
        if (action.whole === "explore" && s.activeIssue === null)
          return reject("Select an issue first.", "authority");
        if (action.inner) {
          if (
            !Object.hasOwn(INNER, action.inner) ||
            action.whole !== "explore" ||
            s.activeIssue === null
          )
            return reject("An inner phase needs an active issue and exploration.", "authority");
          s.issues[s.activeIssue - 1] = copy(
            yield* selectInner(yield* issueById(s, s.activeIssue), action.inner),
          );
        }
        s.whole = action.whole;
        break;
      case "hypothesis":
      case "confirmDraft":
      case "response":
      case "judge":
        s.issues[action.issueId - 1] = copy(
          yield* applyDesignUser(yield* issueById(s, action.issueId), action),
        );
        break;
      default:
        return reject("Unknown user operation", "invalid-input");
    }
    s.sequence++;
    return ok(s);
  });
}
export function applyModel(
  state: State,
  action: ModelAction,
  observation?: Observation,
): Outcome<State> {
  return safeTry(function* () {
    yield* requireActive(state);
    if (!Value.Check(ModelActionSchema, action))
      return reject(
        "Model operation not permitted or invalid. Use only record/proposal operations.",
        "authority",
      );
    let s = copy(state);
    switch (action.type) {
      case "unitDraft":
      case "unitEvidence":
      case "unitReport":
      case "unitSuggestion":
        s = { ...s, ...copy(yield* applyUnitModel(s, action, observation)) };
        break;
      case "proposal":
        s.proposals.push({ id: s.proposals.length + 1, text: yield* content(action.text) });
        break;
      case "draft":
      case "critique":
      case "response":
        s.issues[action.issueId - 1] = copy(
          yield* applyDesignModel(yield* issueById(s, action.issueId), action),
        );
        break;
    }
    s.sequence++;
    return ok(s);
  });
}
export function applyDiscussion(state: State, action: DiscussionAction): Outcome<State> {
  return safeTry(function* () {
    yield* requireActive(state);
    if (!Value.Check(DiscussionActionSchema, action))
      return reject(
        "Discussion operation not permitted or invalid. No decisions, scope confirmation or implementation authority.",
        "authority",
      );
    const s = copy(state);
    switch (action.type) {
      case "goals":
        yield* require(s.whole ===
          "goals", "Organize goals only during the goal discussion. Stage skips need human approval.");
        s.goal = yield* content(action.goal);
        s.constraints = yield* content(action.constraints, true);
        s.whole = "issues";
        break;
      case "issue": {
        yield* require(s.whole ===
          "issues", "Discuss the goals before identifying the next issue. Stage skips need human approval.");
        const id = s.issues.length + 1;
        s.issues.push(copy(yield* createIssue(id, action.text)));
        s.activeIssue = id;
        s.whole = "explore";
        break;
      }
      case "target":
      case "direction":
      case "rethink":
        yield* require(s.whole === "explore" &&
          s.activeIssue !==
            null, "This update needs the current design discussion; it cannot leave implementation or switch units.");
        s.issues[s.activeIssue! - 1] = copy(
          yield* discussIssue(yield* issueById(s, s.activeIssue!), action),
        );
        break;
    }
    s.sequence++;
    s.discussionHistory = [
      ...(s.discussionHistory ?? []),
      { sequence: s.sequence, action: structuredClone(action) },
    ];
    return ok(s);
  });
}
export const activeIssue = (s: State) => s.issues.find((i) => i.id === s.activeIssue);
export const activeUnit = (s: State) => s.units.find((u) => u.id === s.activeUnit);

// All user edges are planned on a private clone. No append, UI, or await occurs in this reducer.
export function transition(
  state: State,
  proposal: Next,
  observation?: Observation,
): Outcome<State> {
  return safeTry(function* () {
    yield* require(state.enabled, "Mentor is paused. Resume explicitly with /mentor.");
    yield* require(Value.Check(
      NextSchema,
      proposal,
    ), "Invalid next-action draft.", "invalid-input");
    let s: State = copy(state);
    const e = proposal.edge;
    const i = activeIssue(s);
    const u = activeUnit(s);
    const user = (a: UserAction) =>
      applyUser(s, a, observation).map((next) => {
        s = next;
      });
    const model = (a: Parameters<typeof applyModel>[1]) =>
      applyModel(s, a, observation).map((next) => {
        s = next;
      });
    const explore = () =>
      require(s.whole === "explore" && i, "This action needs the current design discussion.");
    const implementation = () =>
      require(s.whole === "implementation" &&
        u, "This action needs the current implementation scope.");
    switch (e.type) {
      case "goals":
        yield* require(s.whole === "goals", "Return to the goal discussion first.");
        yield* user({ type: "goal", text: e.goal });
        yield* user({ type: "constraints", text: e.constraints });
        yield* user({ type: "phase", whole: "issues" });
        break;
      case "issue": {
        yield* require(["issues", "consistency", "summary"].includes(
          s.whole,
        ), "Choose an issue from the issue or whole-review discussion.");
        let id = e.issueId;
        if (id !== undefined)
          yield* require((yield* issueById(s, id)).text ===
            e.text, "Issue text changed; prepare a fresh card.", "freshness");
        else {
          yield* user({ type: "issue", text: e.text });
          id = s.issues.length;
        }
        yield* user({ type: "select", issueId: id });
        yield* user({ type: "phase", whole: "explore", inner: "hypothesis" });
        break;
      }
      case "critique": {
        yield* explore();
        yield* require(i!.inner !== "judgment" ||
          e.text !==
            undefined, "Supply the exact revised target to return directly from judgment.");
        const r = currentRevision(i!);
        if (e.text !== undefined && e.text !== r?.text) {
          const saved = i!.revisions.findLast((r) => !r.confirmed && r.text === e.text);
          if (!saved) yield* model({ type: "draft", issueId: i!.id, text: e.text });
          yield* user({
            type: "confirmDraft",
            issueId: i!.id,
            revision: saved?.revision ?? (yield* issueById(s, i!.id)).revisions.length,
          });
        }
        yield* require(currentRevision(
          yield* issueById(s, i!.id),
        ), "Organize an exact proposal before examining it.");
        yield* user({ type: "phase", whole: "explore", inner: "critique" });
        break;
      }
      case "decide":
        yield* explore();
        yield* require(i!.inner === "critique" &&
          currentRevision(i!), "Examine the chosen proposal before deciding direction.");
        yield* user({ type: "phase", whole: "explore", inner: "judgment" });
        break;
      case "adopt":
        yield* explore();
        yield* require(i!.inner === "judgment", "Discuss the direction decision first.");
        yield* require(currentRevision(i!), "Organize an exact proposal before adoption.");
        if (!currentRevision(i!)!.confirmed)
          yield* user({ type: "confirmDraft", issueId: i!.id, revision: i!.currentRevision! });
        yield* user({ type: "judge", issueId: i!.id, decision: "adopt", note: e.note });
        yield* user({ type: "phase", whole: "implementation" });
        s = { ...s, activeUnit: null }; // A design decision must not re-authorize an earlier implementation unit.
        break;
      case "revise":
        yield* explore();
        yield* user({ type: "judge", issueId: i!.id, decision: "revise", note: e.note });
        yield* user({ type: "phase", whole: "explore", inner: "hypothesis" });
        break;
      case "scope": {
        yield* require(s.whole !== "implementation" ||
          !u ||
          u.phase !==
            "implementing", "Stop or inspect the current implementation before changing scope.");
        yield* model({ type: "unitDraft", contract: e.contract });
        const id = s.units.length;
        yield* user({ type: "selectUnit", unitId: id });
        yield* user({ type: "confirmUnit", unitId: id, revision: 1 });
        yield* user({ type: "phase", whole: "implementation" });
        break;
      }
      case "start": {
        yield* require(s.whole === "implementation" &&
          (!u || u.phase === "scope"), "Implementation can start only from scope discussion.");
        let id = u?.id;
        if (e.contract) {
          yield* model({ type: "unitDraft", unitId: id, contract: e.contract });
          id ??= s.units.length;
          yield* user({
            type: "confirmUnit",
            unitId: id,
            revision: (yield* unitById(s, id)).revisions.length,
          });
        }
        yield* require(id !== undefined &&
          unitRevision(yield* unitById(s, id))
            ?.confirmed, "Organize the exact scope, expectations and check plan first.");
        yield* user({ type: "selectUnit", unitId: id! });
        yield* user({ type: "unitPhase", unitId: id!, phase: "implementing" });
        break;
      }
      case "inspect":
        yield* implementation();
        yield* require(u!.phase === "implementing" ||
          u!.phase ===
            "judgment", "Inspect a result after explicit implementation, or re-inspect a past judgment.");
        yield* user({ type: "unitPhase", unitId: u!.id, phase: "examination" });
        break;
      case "accept":
        yield* implementation();
        yield* require(u!.phase === "examination" ||
          u!.phase === "judgment", "Inspect the result before accepting it.");
        yield* user({ type: "unitPhase", unitId: u!.id, phase: "judgment" });
        yield* user({ type: "unitJudge", unitId: u!.id, decision: "accept", note: e.note });
        break;
      case "correct":
        yield* implementation();
        yield* require(u!.phase === "examination" ||
          u!.phase === "judgment", "Request correction after inspecting the result.");
        yield* user({ type: "unitPhase", unitId: u!.id, phase: "judgment" });
        yield* user({ type: "unitJudge", unitId: u!.id, decision: "correction", note: e.note });
        yield* user({ type: "unitPhase", unitId: u!.id, phase: "implementing" });
        break;
      case "design":
        yield* require(s.whole ===
          "implementation", "Return to design from implementation discussion.");
        if (u) {
          yield* user({ type: "unitPhase", unitId: u.id, phase: "judgment" });
          yield* user({ type: "unitJudge", unitId: u.id, decision: "design", note: e.note });
        }
        yield* user({
          type: "phase",
          whole: i ? "explore" : "issues",
          ...(i ? { inner: "hypothesis" as const } : {}),
        });
        break;
      case "defer":
        if (s.whole === "implementation") {
          yield* implementation();
          yield* user({ type: "unitPhase", unitId: u!.id, phase: "judgment" });
          yield* user({ type: "unitJudge", unitId: u!.id, decision: "defer", note: e.note });
        } else {
          yield* explore();
          yield* user({ type: "judge", issueId: i!.id, decision: "defer", note: e.note });
        }
        yield* user({ type: "phase", whole: "issues" });
        break;
      case "review":
        yield* user({ type: "phase", whole: "consistency" });
        break;
      case "finish":
        yield* require(s.whole === "consistency" ||
          s.whole === "summary", "Review the whole work before finishing.");
        yield* user({ type: "phase", whole: "summary" });
        yield* user({ type: "pause" });
        break;
      case "revisitGoals":
        yield* user({ type: "phase", whole: "goals" });
        break;
      case "switchIssue":
        yield* user({ type: "select", issueId: e.issueId });
        yield* user({ type: "phase", whole: "explore" });
        break;
      case "switchUnit":
        yield* user({ type: "selectUnit", unitId: e.unitId });
        yield* user({ type: "phase", whole: "implementation" });
        // Switching to a past scope never restarts its implementation permission.
        if ((yield* unitById(s, e.unitId)).phase === "implementing")
          yield* user({ type: "unitPhase", unitId: e.unitId, phase: "scope" });
        break;
      default:
        return reject("Unknown next action.", "invalid-input");
    }
    return ok({
      ...s,
      sequence: state.sequence + 1,
      guided: {
        history: [
          ...(state.guided?.history ?? []),
          { sequence: state.sequence + 1, proposal: copy(proposal) },
        ],
      },
    });
  });
}

export function proposeNext(
  state: State,
  proposal: Next,
  observation?: Observation,
): Outcome<State> {
  return safeTry(function* () {
    yield* transition(state, proposal, observation); // Validate the complete edge without adopting or advancing it.
    const s = copy(state);
    s.sequence++;
    s.guided = {
      history: s.guided?.history ?? [],
      pending: boundNext(s.sequence, proposal, observation),
    };
    return ok(s);
  });
}
export function defaultNext(s: State, o?: Observation): Next | undefined {
  if (!s.enabled) return undefined;
  const i = activeIssue(s),
    u = activeUnit(s);
  let edge: Edge | undefined;
  if (s.whole === "explore" && i && currentRevision(i)) {
    const draft = i.revisions.findLast((r) => !r.confirmed && r.revision > i.currentRevision!);
    edge = draft
      ? { type: "critique", text: draft.text }
      : i.inner === "hypothesis"
        ? { type: "critique" }
        : i.inner === "critique"
          ? { type: "decide" }
          : undefined;
  } else if (s.whole === "implementation" && u) {
    if (u.phase === "scope" && unitRevision(u)) {
      const draft = u.revisions.findLast((r) => !r.confirmed && r.revision > u.currentRevision!);
      edge = draft ? { type: "start", contract: draft.contract } : { type: "start" };
    } else if (u.phase === "implementing") edge = { type: "inspect" };
    else if (u.phase === "examination") edge = { type: "accept", note: "" };
    else if (u.phase === "judgment")
      edge = unitJudgment(u, o)?.decision === "accept" ? { type: "review" } : { type: "inspect" };
  } else if (s.whole === "consistency" || s.whole === "summary") edge = { type: "finish" };
  return edge ? { summary: "現在の記録を対象に進めます。", unresolved: "", edge } : undefined;
}
export function currentNext(s: State, o?: Observation): Next | undefined {
  // A stale model card is not silently replaced with a different default edge.
  return s.guided?.pending ? pendingNext(s, o) : defaultNext(s, o);
}
export function alternativeEdges(s: State, o?: Observation): Edge[] {
  const result: Edge[] = [{ type: "revisitGoals" }, { type: "review" }];
  if (s.whole === "explore" && activeIssue(s))
    result.push({ type: "revise", note: "" }, { type: "defer", note: "" });
  if (s.whole === "implementation") {
    result.push({ type: "design", note: "" });
    if (activeUnit(s)) result.push({ type: "correct", note: "" }, { type: "defer", note: "" });
  }
  return result.filter((edge) =>
    transition(s, { summary: "進み方を変更します。", unresolved: "", edge }, o).isOk(),
  );
}
