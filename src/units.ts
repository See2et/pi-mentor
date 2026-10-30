import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

export const UNIT_PHASES = { scope: 'スコープ確認', implementing: '実装中', examination: '証拠の検討', judgment: '本人判断' } as const;
export const UNIT_DECISIONS = { accept: 'このスコープを受け入れる', correction: '修正を依頼する', design: '設計に戻る', defer: '保留する' } as const;
export const KINDS = { feature: '機能実装', experiment: '仮説の実験' } as const;
const en = <T extends string>(values: readonly T[]) => Type.Unsafe<T>(Type.Union(values.map(v => Type.Literal(v))));
const text = Type.String({ minLength: 1, maxLength: 6000 });
const id = Type.Integer({ minimum: 1 });
const ref = Type.Union([id, Type.Null()]);
const author = en(['human', 'ai'] as const);
export const ContractSchema = Type.Object({
  kind: en(['feature', 'experiment'] as const), title: text, purpose: text,
  designRefs: Type.Array(text, { minItems: 1 }), scope: text,
  expectations: Type.Array(Type.Object({ id: Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_-]{0,39}$' }), text }, { additionalProperties: false }), { minItems: 1 }),
  nonGoals: text, verificationPlan: text,
}, { additionalProperties: false });
export type Contract = Static<typeof ContractSchema>;
export const SourceSchema = Type.Object({ hash: Type.String({ pattern: '^[a-f0-9]{64}$' }), root: text, checkedAt: text }, { additionalProperties: false });
export type Source = Static<typeof SourceSchema>;
export type Observation = { source?: Source; error?: string; checkedAt: string };
const entries = Type.Array(Type.Object({
  expectationId: Type.String(), observation: text, references: Type.Array(text),
  method: en(['real', 'substitute', 'untested'] as const), limitations: text,
}, { additionalProperties: false }));
export const UnitSchema = Type.Object({
  id, phase: en(Object.keys(UNIT_PHASES) as (keyof typeof UNIT_PHASES)[]), currentRevision: ref,
  revisions: Type.Array(Type.Object({ revision: id, contract: ContractSchema, author, confirmed: Type.Boolean() })),
  evidence: Type.Array(Type.Object({ id, revision: id, source: SourceSchema, entries, concerns: text, author: Type.Literal('ai') })),
  reports: Type.Array(Type.Object({ revision: ref, text, author: Type.Literal('ai') })),
  notes: Type.Array(Type.Object({ revision: ref, text, author })),
  judgments: Type.Array(Type.Object({
    revision: ref, source: Type.Union([SourceSchema, Type.Null()]), sourceError: Type.String(),
    evidenceIds: Type.Array(id), decision: en(Object.keys(UNIT_DECISIONS) as (keyof typeof UNIT_DECISIONS)[]),
    note: Type.String({ maxLength: 6000 }), author: Type.Literal('human'),
  })),
}, { additionalProperties: false });
export type Unit = Static<typeof UnitSchema>;
export type UnitState = { units: Unit[]; activeUnit: number | null; whole: string };
export const UnitModelSchemas = [
  Type.Object({ type: Type.Literal('unitDraft'), unitId: Type.Optional(id), contract: ContractSchema }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('unitEvidence'), unitId: id, revision: id, sourceHash: Type.String(), entries, concerns: text }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('unitReport'), unitId: id, revision: ref, text }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('unitSuggestion'), unitId: id, revision: ref, text }, { additionalProperties: false }),
] as const;
export type UnitModelAction = Static<(typeof UnitModelSchemas)[number]>;
export type UnitUserAction =
  | { type: 'unitContract'; unitId?: number; contract: Contract }
  | { type: 'confirmUnit'; unitId: number; revision: number }
  | { type: 'selectUnit'; unitId: number }
  | { type: 'unitPhase'; unitId: number; phase: Unit['phase'] }
  | { type: 'unitNote'; unitId: number; text: string }
  | { type: 'unitJudge'; unitId: number; decision: keyof typeof UNIT_DECISIONS; note: string };
export function unitById(s: UnitState, id: number): Unit {
  const unit = s.units.find(u => u.id === id);
  if (!unit) throw new Error('Unit not found; refresh mentor_status.');
  return unit;
}
export const unitRevision = (u: Unit) => u.revisions.find(r => r.revision === u.currentRevision);
export function sameSource(a?: Source | null, b?: Source | null): boolean { return !!a && !!b && a.hash === b.hash && a.root === b.root; }
export function evidenceFreshness(u: Unit, o?: Observation): string {
  if (!o?.source) return '鮮度不明（ソース観測不可）';
  const last = u.evidence.at(-1);
  if (!last) return '証拠未提出';
  return last.revision === u.currentRevision && sameSource(last.source, o.source) ? '証拠: 最終確認時一致' : '証拠: 古い（契約／ソース不一致）';
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
  if (!latest) return '未判断（現契約）';
  const decision = UNIT_DECISIONS[latest.decision];
  if (!latest.source || !o?.source) return `最新判断: ${decision}（ソース紐付け不明）`;
  if (!sameSource(latest.source, o.source)) return `最新判断: ${decision}（現ソースとは不一致）`;
  return decision;
}
function clean(text: string, empty = false) {
  if (typeof text !== 'string' || (!empty && !text.trim()) || text.length > 6000) throw new Error('Text must be 1–6000 characters.');
  return text.trim();
}
function validateContract(contract: Contract) {
  if (!Value.Check(ContractSchema, contract) || new Set(contract.expectations.map(e => e.id)).size !== contract.expectations.length) throw new Error('Invalid contract or duplicate expectation IDs.');
  for (const t of [contract.title, contract.purpose, ...contract.designRefs, contract.scope, ...contract.expectations.map(e => e.text), contract.nonGoals, contract.verificationPlan]) clean(t);
}
function draft(s: UnitState, contract: Contract, author: 'ai' | 'human', unitId?: number, confirmed = false) {
  validateContract(contract);
  const u = unitId ? unitById(s, unitId) : { id: s.units.length + 1, phase: 'scope' as const, currentRevision: null, revisions: [], evidence: [], reports: [], notes: [], judgments: [] } as Unit;
  if (!unitId) s.units.push(u);
  u.revisions.push({ revision: u.revisions.length + 1, contract: structuredClone(contract), author, confirmed });
  if (confirmed) { u.currentRevision = u.revisions.length; u.phase = 'scope'; }
}
export function applyUnitUser(s: UnitState, a: UnitUserAction, o?: Observation): void {
  if (a.type === 'unitContract') { draft(s, a.contract, 'human', a.unitId, true); return; }
  const u = unitById(s, a.unitId);
  if (a.type === 'selectUnit') { s.activeUnit = u.id; return; }
  if (a.type === 'confirmUnit') {
    const r = u.revisions.find(r => r.revision === a.revision);
    if (!r || r.confirmed) throw new Error('Draft unavailable; refresh.');
    r.confirmed = true; u.currentRevision = r.revision; u.phase = 'scope'; return;
  }
  if (s.activeUnit !== u.id || s.whole !== 'implementation') throw new Error('Select this unit and implementation activity explicitly first.');
  switch (a.type) {
    case 'unitPhase':
      if (!Object.hasOwn(UNIT_PHASES, a.phase)) throw new Error('Unknown unit phase');
      if ((a.phase === 'implementing' || a.phase === 'examination') && !unitRevision(u)?.confirmed) throw new Error('Confirm an exact contract before starting.');
      u.phase = a.phase; break;
    case 'unitNote': u.notes.push({ revision: u.currentRevision, text: clean(a.text), author: 'human' }); break;
    case 'unitJudge':
      if (u.phase !== 'judgment') throw new Error('Move explicitly to unit judgment first.');
      if (!Object.hasOwn(UNIT_DECISIONS, a.decision)) throw new Error('Unknown judgment');
      if (a.decision === 'accept' && !unitRevision(u)?.confirmed) throw new Error('Confirm an exact contract before acceptance.');
      u.judgments.push({ revision: u.currentRevision, source: o?.source ?? null, sourceError: o?.error ?? (o?.source ? '' : 'Source freshness unknown'), evidenceIds: u.evidence.map(e => e.id), decision: a.decision, note: clean(a.note, true), author: 'human' });
      // A design return is the explicitly named human transition, not experiment adoption.
      if (a.decision === 'design') s.whole = 'issues';
      break;
  }
}
export function applyUnitModel(s: UnitState, a: UnitModelAction, o?: Observation): void {
  if (a.type === 'unitDraft') { draft(s, a.contract, 'ai', a.unitId); return; }
  const u = unitById(s, a.unitId);
  if (s.activeUnit !== u.id || s.whole !== 'implementation') throw new Error('Work only on the human-selected active implementation unit.');
  if (a.revision !== u.currentRevision) throw new Error('Contract revision changed; refresh.');
  if (a.type === 'unitEvidence') {
    if (!unitRevision(u)?.confirmed) throw new Error('Confirm an exact contract first.');
    if (!o?.source || a.sourceHash !== o.source.hash) throw new Error('Source snapshot changed or unavailable; evidence not bound. Refresh mentor_status.');
    const ids = new Set(unitRevision(u)!.contract.expectations.map(e => e.id));
    if (a.entries.some(e => !ids.has(e.expectationId))) throw new Error('Evidence must reference expectation IDs on this exact contract.');
    for (const e of a.entries) { clean(e.observation); clean(e.limitations); e.references.forEach(r => clean(r)); }
    u.evidence.push({ id: u.evidence.length + 1, revision: a.revision, source: structuredClone(o.source), entries: structuredClone(a.entries), concerns: clean(a.concerns), author: 'ai' });
  } else if (a.type === 'unitReport') u.reports.push({ revision: a.revision, text: clean(a.text), author: 'ai' });
  else u.notes.push({ revision: a.revision, text: clean(a.text), author: 'ai' });
}
export function validUnits(s: UnitState): boolean {
  if (s.activeUnit !== null && !s.units.some(u => u.id === s.activeUnit)) return false;
  return s.units.every((u, n) => u.id === n + 1 &&
    (!(u.phase === 'implementing' || u.phase === 'examination') || !!unitRevision(u)?.confirmed) &&
    (u.currentRevision === null || u.revisions.some(r => r.revision === u.currentRevision && r.confirmed)) &&
    u.revisions.every((r, n) => { try { validateContract(r.contract); return r.revision === n + 1 && (r.author !== 'human' || r.confirmed); } catch { return false; } }) &&
    u.evidence.every((e, n) => e.id === n + 1 && u.revisions.some(r => r.revision === e.revision && r.confirmed && e.entries.every(e => r.contract.expectations.some(x => x.id === e.expectationId)))) &&
    [...u.notes, ...u.reports].every(x => x.revision === null || u.revisions.some(r => r.revision === x.revision)) &&
    u.judgments.every(j => (j.revision === null ? j.decision !== 'accept' : u.revisions.some(r => r.revision === j.revision && r.confirmed)) && j.evidenceIds.every(id => u.evidence.some(e => e.id === id))));
}
export function contractText(u: Unit, revision = u.currentRevision): string {
  const r = u.revisions.find(r => r.revision === revision);
  if (!r) return `単位 U${u.id}: 確認済み契約なし`;
  const c = r.contract;
  return `U${u.id} / 契約 v${r.revision} [${r.author}; ${r.confirmed ? '本人確認済み' : '未確認'}]\n${KINDS[c.kind]}: ${c.title}\n目的: ${c.purpose}\n設計参照:\n${c.designRefs.join('\n')}\nスコープ:\n${c.scope}\n期待:\n${c.expectations.map(e => `${e.id}: ${e.text}`).join('\n')}\n非目標:\n${c.nonGoals}\n検証計画（期待とは別）:\n${c.verificationPlan}`;
}
export function unitDetails(u: Unit, o?: Observation): string {
  const binding = unitRevision(u)?.contract.expectations.map(x => {
    const refs = u.evidence.filter(e => e.revision === u.currentRevision && sameSource(e.source, o?.source) && e.entries.some(entry => entry.expectationId === x.id));
    return `${x.id}: ${refs.length ? refs.map(e => `証拠 #${e.id}`).join(', ') + '（観測を読む。充足判定ではない）' : '現契約・最終観測ソースに紐づく証拠なし／不明'}`;
  }).join('\n') ?? '確認済み期待なし';
  return `${contractText(u)}\n\n${evidenceFreshness(u, o)}\n${unitJudgmentStatus(u, o)}\n現在ソース: ${o?.source ? JSON.stringify(o.source) : o?.error ?? '不明'}\n観測範囲: Git追跡対象＋非ignored未追跡ファイルの内容・削除・実行属性。ignored / 外部サービス / 依存環境は対象外。最終確認時の一致でありライブ監視・隔離ではありません。\n\n現在の期待と証拠の対応（採点なし）:\n${binding}\n\n証拠（履歴。テスト成功は充足判定ではありません）:\n${u.evidence.map(e => `証拠 #${e.id} / 契約 v${e.revision} / ${JSON.stringify(e.source)}\n${e.entries.map(x => `${x.expectationId} [${x.method}] ${x.observation}\n参照・コマンド・結果: ${x.references.join('\n')}\n限界・未知: ${x.limitations}`).join('\n')}\n懸念: ${e.concerns}`).join('\n\n') || '未提出（未検証の期待あり）'}\n\nAI報告（準備完了は本人判断ではありません）:\n${u.reports.map(x => `v${x.revision}: ${x.text}`).join('\n') || 'なし'}\n\n質問・学習メモ（任意・採点なし）:\n${u.notes.map(x => `v${x.revision} [${x.author}]: ${x.text}`).join('\n') || 'なし'}\n\n本人判断履歴（別契約・ソースへ継承しません）:\n${u.judgments.map(j => `v${j.revision} / ${JSON.stringify(j.source)} ${j.sourceError}\n証拠参照: ${j.evidenceIds.join(', ')}\n${UNIT_DECISIONS[j.decision]}: ${j.note}`).join('\n') || '未判断'}\n\n証拠のない期待・未知の懸念があっても、本人が留保を記録して判断できます。実験の受け入れは設計・機能の採用ではありません。`;
}
