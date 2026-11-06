import { ok, safeTry } from "neverthrow";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { reject, type Outcome } from "./errors.ts";
import { content, copy, type ReadonlyValue } from "./value.ts";

export const INNER = { hypothesis: "仮説形成", critique: "批判・弁護", judgment: "判断" } as const;
export const DECISIONS = { adopt: "暫定採用", revise: "修正する", defer: "保留" } as const;
const enumOf = <T extends string>(values: readonly T[]) =>
  Type.Unsafe<T>(Type.Union(values.map((v) => Type.Literal(v))));
const text = Type.String({ minLength: 1, maxLength: 6000 });
const id = Type.Integer({ minimum: 1 });
const revisionRef = Type.Union([id, Type.Null()]);
const author = enumOf(["human", "ai"] as const);
const inner = enumOf(Object.keys(INNER) as (keyof typeof INNER)[]);
const decision = enumOf(Object.keys(DECISIONS) as (keyof typeof DECISIONS)[]);
const category = enumOf(["correctness", "security", "convention", "uncertainty"] as const);
export const IssueSchema = Type.Object({
  id,
  text,
  inner,
  revisions: Type.Array(Type.Object({ revision: id, text, author, confirmed: Type.Boolean() })),
  currentRevision: revisionRef,
  critiques: Type.Array(
    Type.Object({
      id,
      revision: id,
      category,
      text,
      evidence: text,
      status: enumOf(["open", "withdrawn"] as const),
      replaces: Type.Optional(id),
    }),
  ),
  responses: Type.Array(
    Type.Object({ revision: revisionRef, critiqueId: Type.Optional(id), text, author }),
  ),
  judgments: Type.Array(
    Type.Object({
      revision: revisionRef,
      decision,
      note: Type.String({ maxLength: 6000 }),
      author: Type.Literal("human"),
    }),
  ),
});
export type Issue = ReadonlyValue<Static<typeof IssueSchema>>;
export type DesignUserAction =
  | { type: "hypothesis"; issueId: number; text: string }
  | { type: "confirmDraft"; issueId: number; revision: number }
  | { type: "response"; issueId: number; text: string; critiqueId?: number }
  | { type: "judge"; issueId: number; decision: keyof typeof DECISIONS; note: string };
export const DesignModelSchemas = [
  Type.Object({ type: Type.Literal("draft"), issueId: id, text }, { additionalProperties: false }),
  Type.Object(
    {
      type: Type.Literal("critique"),
      issueId: id,
      revision: id,
      category,
      text,
      evidence: text,
      status: enumOf(["open", "withdrawn"] as const),
      replaces: Type.Optional(id),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("response"),
      issueId: id,
      revision: revisionRef,
      critiqueId: Type.Optional(id),
      text,
    },
    { additionalProperties: false },
  ),
] as const;
const DesignModelSchema = Type.Union([...DesignModelSchemas]);
export type DesignModelAction = Static<typeof DesignModelSchema>;
export const DiscussionActionSchema = Type.Union([
  Type.Object(
    { type: Type.Literal("goals"), goal: text, constraints: Type.String({ maxLength: 6000 }) },
    { additionalProperties: false },
  ),
  Type.Object({ type: Type.Literal("issue"), text }, { additionalProperties: false }),
  Type.Object(
    { type: Type.Literal("target"), text, issueId: Type.Optional(id) },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("focus"), issueId: id, revision: Type.Optional(revisionRef) },
    { additionalProperties: false },
  ),
  Type.Object({ type: Type.Literal("direction") }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("rethink") }, { additionalProperties: false }),
]);
export type DiscussionAction = Static<typeof DiscussionActionSchema>;
export function issueById(s: { readonly issues: readonly Issue[] }, id: number): Outcome<Issue> {
  const issue = s.issues.find((i) => i.id === id);
  return issue ? ok(issue) : reject("Issue not found; refresh mentor_status.", "missing-target");
}
export const createIssue = (id: number, text: string): Outcome<Issue> =>
  content(text).map((text) => ({
    id,
    text,
    inner: "hypothesis",
    currentRevision: null,
    revisions: [],
    critiques: [],
    responses: [],
    judgments: [],
  }));
export const renameIssue = (issue: Issue, text: string): Outcome<Issue> =>
  content(text).map((text) => ({ ...copy(issue), text }));
// The discussion target may be AI-unconfirmed; only human confirmation sets confirmed.
export function currentRevision(issue: Issue) {
  return issue.revisions.find((r) => r.revision === issue.currentRevision);
}
export function currentJudgment(issue: Issue) {
  return issue.judgments.findLast((j) => j.revision === issue.currentRevision);
}
// Reusing an earlier or already judged target would revive its historical decision.
export function newerDraft(issue: Issue, text: string) {
  return issue.revisions.findLast(
    (r) =>
      !r.confirmed &&
      r.revision > (issue.currentRevision ?? 0) &&
      r.text === text &&
      !issue.judgments.some((j) => j.revision === r.revision),
  );
}
export function concerns(issue: Issue, revision = issue.currentRevision) {
  const replaced = new Set(issue.critiques.map((c) => c.replaces));
  return issue.critiques.filter(
    (c) => c.revision === revision && c.status === "open" && !replaced.has(c.id),
  );
}
export function selectInner(issue: Issue, inner: Issue["inner"]): Outcome<Issue> {
  if (!Object.hasOwn(INNER, inner))
    return reject("An inner phase needs an active issue and exploration.", "authority");
  return ok({ ...copy(issue), inner });
}
export function applyDesignUser(issue: Issue, action: DesignUserAction): Outcome<Issue> {
  return safeTry(function* () {
    const i = copy(issue);
    switch (action.type) {
      case "hypothesis": {
        const revision = i.revisions.length + 1;
        i.revisions.push({
          revision,
          text: yield* content(action.text),
          author: "human",
          confirmed: true,
        });
        i.currentRevision = revision;
        break;
      }
      case "confirmDraft": {
        const r = i.revisions.find((r) => r.revision === action.revision);
        if (!r || r.confirmed) return reject("Draft no longer available; refresh.", "freshness");
        r.confirmed = true;
        i.currentRevision = r.revision;
        break;
      }
      case "response":
        if (
          action.critiqueId &&
          !i.critiques.some((c) => c.id === action.critiqueId && c.revision === i.currentRevision)
        )
          return reject("Critique is not on the current revision.", "freshness");
        i.responses.push({
          revision: i.currentRevision,
          critiqueId: action.critiqueId,
          text: yield* content(action.text),
          author: "human",
        });
        break;
      case "judge":
        if (!Object.hasOwn(DECISIONS, action.decision))
          return reject("Unknown judgment", "invalid-input");
        if (action.decision === "adopt" && !currentRevision(i)?.confirmed)
          return reject("Confirm or write an exact hypothesis before adoption.", "authority");
        i.judgments.push({
          revision: i.currentRevision,
          decision: action.decision,
          note: yield* content(action.note, true),
          author: "human",
        });
        break;
      default:
        return reject("Unknown user operation", "invalid-input");
    }
    return ok(i);
  });
}
export function applyDesignModel(issue: Issue, action: DesignModelAction): Outcome<Issue> {
  return safeTry(function* () {
    if (!Value.Check(DesignModelSchema, action))
      return reject(
        "Model operation not permitted or invalid. Use only record/proposal operations.",
        "authority",
      );
    const i = copy(issue);
    switch (action.type) {
      case "draft":
        i.revisions.push({
          revision: i.revisions.length + 1,
          text: yield* content(action.text),
          author: "ai",
          confirmed: false,
        });
        break;
      case "critique": {
        if (!i.revisions.some((r) => r.revision === action.revision))
          return reject("Hypothesis revision not found; refresh mentor_status.", "missing-target");
        if (action.replaces !== undefined) {
          const prior = i.critiques.find((c) => c.id === action.replaces);
          if (!prior || prior.revision !== action.revision)
            return reject(
              "A correction must reference a critique on the same revision.",
              "freshness",
            );
          if (i.critiques.some((c) => c.replaces === prior.id))
            return reject(
              "Critique already superseded. Update its latest correction instead.",
              "freshness",
            );
        } else if (action.status === "withdrawn")
          return reject("Withdrawal must reference a previous critique.", "invalid-input");
        i.critiques.push({
          id: i.critiques.length + 1,
          revision: action.revision,
          category: action.category,
          text: yield* content(action.text),
          evidence: yield* content(action.evidence),
          status: action.status,
          replaces: action.replaces,
        });
        break;
      }
      case "response":
        if (action.revision !== null && !i.revisions.some((r) => r.revision === action.revision))
          return reject("Revision not found", "missing-target");
        if (
          action.critiqueId &&
          !i.critiques.some((c) => c.id === action.critiqueId && c.revision === action.revision)
        )
          return reject("Response must bind the same revision as the critique.", "freshness");
        i.responses.push({
          revision: action.revision,
          critiqueId: action.critiqueId,
          text: yield* content(action.text),
          author: "ai",
        });
        break;
    }
    return ok(i);
  });
}
export function discussIssue(
  issue: Issue,
  action: Extract<DiscussionAction, { type: "target" | "direction" | "rethink" }>,
): Outcome<Issue> {
  return safeTry(function* () {
    const i = copy(issue);
    // Old operation names remain readable/restorable, but cannot cross educational modes.
    if (action.type === "direction" || action.type === "rethink") {
      const required = action.type === "direction" ? "critique" : "hypothesis";
      if (i.inner !== required)
        return reject(
          "Changing discussion mode requires an explicit mode proposal and human approval.",
          "authority",
        );
    } else {
      const text = yield* content(action.text);
      if (currentRevision(i)?.text !== text || currentJudgment(i)) {
        const saved = newerDraft(i, text);
        if (saved) i.currentRevision = saved.revision;
        else {
          const revision = i.revisions.length + 1;
          i.revisions.push({ revision, text, author: "ai", confirmed: false });
          i.currentRevision = revision;
        }
      }
    }
    return ok(i);
  });
}
export function validDesign(s: {
  readonly activeIssue: number | null;
  readonly whole: string;
  readonly issues: readonly Issue[];
}): boolean {
  if (s.activeIssue !== null && !s.issues.some((i) => i.id === s.activeIssue)) return false;
  if (s.whole === "explore" && s.activeIssue === null) return false;
  return s.issues.every(
    (i, n) =>
      i.id === n + 1 &&
      (i.currentRevision === null || i.revisions.some((r) => r.revision === i.currentRevision)) &&
      i.revisions.every((r, n) => r.revision === n + 1 && (r.author !== "human" || r.confirmed)) &&
      i.critiques.every(
        (c, n) =>
          c.id === n + 1 &&
          i.revisions.some((r) => r.revision === c.revision) &&
          (c.replaces === undefined ||
            i.critiques.some(
              (p) => p.id === c.replaces && p.id < c.id && p.revision === c.revision,
            )),
      ) &&
      i.responses.every(
        (r) =>
          (r.revision === null || i.revisions.some((v) => v.revision === r.revision)) &&
          (r.critiqueId === undefined ||
            i.critiques.some((c) => c.id === r.critiqueId && c.revision === r.revision)),
      ) &&
      i.judgments.every((j) =>
        j.revision === null
          ? j.decision !== "adopt"
          : i.revisions.some(
              (r) => r.revision === j.revision && (j.decision !== "adopt" || r.confirmed),
            ),
      ),
  );
}
