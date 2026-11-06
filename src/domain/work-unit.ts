import { ok, safeTry } from "neverthrow";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { reject, type Outcome } from "./errors.ts";
import { copy, requireActive, type ReadonlyValue } from "./value.ts";

export const UNIT_PHASES = {
  scope: "スコープ確認",
  implementing: "実装中",
  examination: "証拠の検討",
  judgment: "本人判断",
} as const;
export const UNIT_DECISIONS = {
  accept: "このスコープを受け入れる",
  correction: "修正を依頼する",
  design: "設計に戻る",
  defer: "保留する",
} as const;
export const KINDS = { feature: "機能実装", experiment: "仮説の実験" } as const;
const en = <T extends string>(values: readonly T[]) =>
  Type.Unsafe<T>(Type.Union(values.map((v) => Type.Literal(v))));
const text = Type.String({ minLength: 1, maxLength: 6000 });
const id = Type.Integer({ minimum: 1 });
const ref = Type.Union([id, Type.Null()]);
const author = en(["human", "ai"] as const);
export const ContractSchema = Type.Object(
  {
    kind: en(["feature", "experiment"] as const),
    title: text,
    purpose: text,
    designRefs: Type.Array(text, { minItems: 1 }),
    scope: text,
    expectations: Type.Array(
      Type.Object(
        { id: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]{0,39}$" }), text },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    nonGoals: text,
    verificationPlan: text,
  },
  { additionalProperties: false },
);
export type Contract = ReadonlyValue<Static<typeof ContractSchema>>;
export const SourceSchema = Type.Object(
  { hash: Type.String({ pattern: "^[a-f0-9]{64}$" }), root: text, checkedAt: text },
  { additionalProperties: false },
);
export type Source = Static<typeof SourceSchema>;
export type Observation = { source?: Source; error?: string; checkedAt: string };
const entries = Type.Array(
  Type.Object(
    {
      expectationId: Type.String(),
      observation: text,
      references: Type.Array(text),
      method: en(["real", "substitute", "untested"] as const),
      limitations: text,
    },
    { additionalProperties: false },
  ),
);
export const UnitSchema = Type.Object(
  {
    id,
    phase: en(Object.keys(UNIT_PHASES) as (keyof typeof UNIT_PHASES)[]),
    currentRevision: ref,
    revisions: Type.Array(
      Type.Object({ revision: id, contract: ContractSchema, author, confirmed: Type.Boolean() }),
    ),
    evidence: Type.Array(
      Type.Object({
        id,
        revision: id,
        source: SourceSchema,
        entries,
        concerns: text,
        author: Type.Literal("ai"),
      }),
    ),
    reports: Type.Array(Type.Object({ revision: ref, text, author: Type.Literal("ai") })),
    notes: Type.Array(Type.Object({ revision: ref, text, author })),
    judgments: Type.Array(
      Type.Object({
        revision: ref,
        source: Type.Union([SourceSchema, Type.Null()]),
        sourceError: Type.String(),
        evidenceIds: Type.Array(id),
        decision: en(Object.keys(UNIT_DECISIONS) as (keyof typeof UNIT_DECISIONS)[]),
        note: Type.String({ maxLength: 6000 }),
        author: Type.Literal("human"),
      }),
    ),
  },
  { additionalProperties: false },
);
export type Unit = ReadonlyValue<Static<typeof UnitSchema>>;
export type WorkUnits = { readonly units: readonly Unit[]; readonly activeUnit: number | null };
type UnitContext = WorkUnits & { readonly enabled: boolean; readonly whole: string };
export const UnitModelSchemas = [
  Type.Object(
    { type: Type.Literal("unitDraft"), unitId: Type.Optional(id), contract: ContractSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("unitEvidence"),
      unitId: id,
      revision: id,
      sourceHash: Type.String(),
      entries,
      concerns: text,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("unitReport"), unitId: id, revision: ref, text },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("unitSuggestion"), unitId: id, revision: ref, text },
    { additionalProperties: false },
  ),
] as const;
export type UnitModelAction = ReadonlyValue<Static<(typeof UnitModelSchemas)[number]>>;
export type UnitUserAction =
  | { type: "unitContract"; unitId?: number; contract: Contract }
  | { type: "confirmUnit"; unitId: number; revision: number }
  | { type: "selectUnit"; unitId: number }
  | { type: "unitPhase"; unitId: number; phase: Unit["phase"] }
  | { type: "unitNote"; unitId: number; text: string }
  | { type: "unitJudge"; unitId: number; decision: keyof typeof UNIT_DECISIONS; note: string };
export function unitById<S extends Pick<WorkUnits, "units">>(
  s: S,
  id: number,
): Outcome<S["units"][number]> {
  const unit = s.units.find((u) => u.id === id);
  return unit ? ok(unit) : reject("Unit not found; refresh mentor_status.", "missing-target");
}
export const unitRevision = (u: Unit) => u.revisions.find((r) => r.revision === u.currentRevision);
export function sameSource(a?: Source | null, b?: Source | null): boolean {
  return !!a && !!b && a.hash === b.hash && a.root === b.root;
}
export function evidenceFreshness(u: Unit, o?: Observation): string {
  if (!o?.source) return "鮮度不明（ソース観測不可）";
  const last = u.evidence.at(-1);
  if (!last) return "証拠未提出";
  return last.revision === u.currentRevision && sameSource(last.source, o.source)
    ? "証拠: 最終確認時一致"
    : "証拠: 古い（契約／ソース不一致）";
}
export function latestUnitJudgment(u: Unit) {
  const latest = u.judgments.at(-1);
  return latest?.revision === u.currentRevision ? latest : undefined;
}
export function unitJudgment(u: Unit, o?: Observation) {
  const latest = latestUnitJudgment(u);
  return latest && sameSource(latest.source, o?.source) ? latest : undefined;
}
export function unitJudgmentStatus(u: Unit, o?: Observation): string {
  const latest = latestUnitJudgment(u);
  if (!latest) return "未判断（現契約）";
  const decision = UNIT_DECISIONS[latest.decision];
  if (!latest.source || !o?.source) return `最新判断: ${decision}（ソース紐付け不明）`;
  if (!sameSource(latest.source, o.source)) return `最新判断: ${decision}（現ソースとは不一致）`;
  return decision;
}
function clean(text: string, empty = false): Outcome<string> {
  if (typeof text !== "string" || (!empty && !text.trim()) || text.length > 6000)
    return reject("Text must be 1–6000 characters.", "invalid-input");
  return ok(text.trim());
}
function validateContract(contract: Contract): Outcome<void> {
  return safeTry(function* () {
    if (
      !Value.Check(ContractSchema, contract) ||
      new Set(contract.expectations.map((e) => e.id)).size !== contract.expectations.length
    )
      return reject("Invalid contract or duplicate expectation IDs.", "invalid-input");
    for (const t of [
      contract.title,
      contract.purpose,
      ...contract.designRefs,
      contract.scope,
      ...contract.expectations.map((e) => e.text),
      contract.nonGoals,
      contract.verificationPlan,
    ])
      yield* clean(t);
    return ok(undefined);
  });
}
function draft(
  s: ReturnType<typeof copy<WorkUnits>>,
  contract: Contract,
  author: "ai" | "human",
  unitId?: number,
  confirmed = false,
): Outcome<void> {
  return safeTry(function* () {
    yield* validateContract(contract);
    const u: ReturnType<typeof copy<Unit>> = unitId
      ? yield* unitById(s, unitId)
      : {
          id: s.units.length + 1,
          phase: "scope",
          currentRevision: null,
          revisions: [],
          evidence: [],
          reports: [],
          notes: [],
          judgments: [],
        };
    if (!unitId) s.units.push(u);
    u.revisions.push({
      revision: u.revisions.length + 1,
      contract: copy(contract),
      author,
      confirmed,
    });
    if (confirmed) {
      u.currentRevision = u.revisions.length;
      u.phase = "scope";
    }
    return ok(undefined);
  });
}
export function applyUnitUser(
  state: UnitContext,
  a: UnitUserAction,
  o?: Observation,
): Outcome<WorkUnits> {
  return safeTry(function* () {
    yield* requireActive(state);
    const s = copy({ units: state.units, activeUnit: state.activeUnit });
    if (a.type === "unitContract") {
      yield* draft(s, a.contract, "human", a.unitId, true);
      return ok(s);
    }
    const u = yield* unitById(s, a.unitId);
    if (a.type === "selectUnit") {
      s.activeUnit = u.id;
      return ok(s);
    }
    if (a.type === "confirmUnit") {
      const r = u.revisions.find((r) => r.revision === a.revision);
      if (!r || r.confirmed) return reject("Draft unavailable; refresh.", "freshness");
      r.confirmed = true;
      u.currentRevision = r.revision;
      u.phase = "scope";
      return ok(s);
    }
    if (state.activeUnit !== u.id || state.whole !== "implementation")
      return reject("Select this unit and implementation activity explicitly first.", "authority");
    switch (a.type) {
      case "unitPhase":
        if (!Object.hasOwn(UNIT_PHASES, a.phase))
          return reject("Unknown unit phase", "invalid-input");
        if (
          (a.phase === "implementing" || a.phase === "examination") &&
          !unitRevision(u)?.confirmed
        )
          return reject("Confirm an exact contract before starting.", "authority");
        u.phase = a.phase;
        break;
      case "unitNote":
        u.notes.push({ revision: u.currentRevision, text: yield* clean(a.text), author: "human" });
        break;
      case "unitJudge":
        if (u.phase !== "judgment")
          return reject("Move explicitly to unit judgment first.", "authority");
        if (!Object.hasOwn(UNIT_DECISIONS, a.decision))
          return reject("Unknown judgment", "invalid-input");
        if (a.decision === "accept" && !unitRevision(u)?.confirmed)
          return reject("Confirm an exact contract before acceptance.", "authority");
        u.judgments.push({
          revision: u.currentRevision,
          source: o?.source ? copy(o.source) : null,
          sourceError: o?.error ?? (o?.source ? "" : "Source freshness unknown"),
          evidenceIds: u.evidence.map((e) => e.id),
          decision: a.decision,
          note: yield* clean(a.note, true),
          author: "human",
        });
        break;
      default:
        return reject("Unknown user operation", "invalid-input");
    }
    return ok(s);
  });
}
export function applyUnitModel(
  state: UnitContext,
  a: UnitModelAction,
  o?: Observation,
): Outcome<WorkUnits> {
  return safeTry(function* () {
    yield* requireActive(state);
    if (!Value.Check(Type.Union([...UnitModelSchemas]), a))
      return reject(
        "Model operation not permitted or invalid. Use only record/proposal operations.",
        "authority",
      );
    const s = copy({ units: state.units, activeUnit: state.activeUnit });
    if (a.type === "unitDraft") {
      yield* draft(s, a.contract, "ai", a.unitId);
      return ok(s);
    }
    const u = yield* unitById(s, a.unitId);
    if (state.activeUnit !== u.id || state.whole !== "implementation")
      return reject("Work only on the human-selected active implementation unit.", "authority");
    if (a.revision !== u.currentRevision)
      return reject("Contract revision changed; refresh.", "freshness");
    if (a.type === "unitEvidence") {
      if (!unitRevision(u)?.confirmed)
        return reject("Confirm an exact contract first.", "authority");
      if (!o?.source || a.sourceHash !== o.source.hash)
        return reject(
          "Source snapshot changed or unavailable; evidence not bound. Refresh mentor_status.",
          "freshness",
        );
      const ids = new Set(unitRevision(u)!.contract.expectations.map((e) => e.id));
      if (a.entries.some((e) => !ids.has(e.expectationId)))
        return reject(
          "Evidence must reference expectation IDs on this exact contract.",
          "invalid-input",
        );
      for (const e of a.entries) {
        yield* clean(e.observation);
        yield* clean(e.limitations);
        for (const reference of e.references) yield* clean(reference);
      }
      u.evidence.push({
        id: u.evidence.length + 1,
        revision: a.revision,
        source: structuredClone(o.source),
        entries: structuredClone(a.entries),
        concerns: yield* clean(a.concerns),
        author: "ai",
      });
    } else if (a.type === "unitReport")
      u.reports.push({ revision: a.revision, text: yield* clean(a.text), author: "ai" });
    else u.notes.push({ revision: a.revision, text: yield* clean(a.text), author: "ai" });
    return ok(s);
  });
}
export function validUnits(s: WorkUnits): boolean {
  if (s.activeUnit !== null && !s.units.some((u) => u.id === s.activeUnit)) return false;
  return s.units.every(
    (u, n) =>
      u.id === n + 1 &&
      (!(u.phase === "implementing" || u.phase === "examination") ||
        !!unitRevision(u)?.confirmed) &&
      (u.currentRevision === null ||
        u.revisions.some((r) => r.revision === u.currentRevision && r.confirmed)) &&
      u.revisions.every(
        (r, n) =>
          validateContract(r.contract).isOk() &&
          r.revision === n + 1 &&
          (r.author !== "human" || r.confirmed),
      ) &&
      u.evidence.every(
        (e, n) =>
          e.id === n + 1 &&
          u.revisions.some(
            (r) =>
              r.revision === e.revision &&
              r.confirmed &&
              e.entries.every((e) => r.contract.expectations.some((x) => x.id === e.expectationId)),
          ),
      ) &&
      [...u.notes, ...u.reports].every(
        (x) => x.revision === null || u.revisions.some((r) => r.revision === x.revision),
      ) &&
      u.judgments.every(
        (j) =>
          (j.revision === null
            ? j.decision !== "accept"
            : u.revisions.some((r) => r.revision === j.revision && r.confirmed)) &&
          j.evidenceIds.every((id) => u.evidence.some((e) => e.id === id)),
      ),
  );
}
