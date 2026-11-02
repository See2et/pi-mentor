import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyModel, applyUser, initialState, restore } from '../src/domain.ts';
import { actionMeaning, operationFeedback, currentNext, exactArtifact, pendingNext, proposeNext, transition } from '../src/guided.ts';
import type { Edge, Next } from '../src/guided-schema.ts';
import type { Contract, Observation } from '../src/units.ts';

const observation: Observation = { checkedAt: 'now', source: { hash: 'a'.repeat(64), root: '/repo', checkedAt: 'now' } };
const other: Observation = { checkedAt: 'later', source: { hash: 'b'.repeat(64), root: '/repo', checkedAt: 'later' } };
const contract: Contract = { kind: 'experiment', title: 'キャッシュの挙動を確かめる', purpose: '前提の確認', designRefs: ['未採用の仮説'], scope: 'ローカルでの実験', expectations: [{ id: 'E1', text: '更新後の応答を観測できる' }], nonGoals: '機能採用', verificationPlan: '実験スクリプトで更新を観測' };
const next = (edge: Edge): Next => ({ summary: '会話から整理', unresolved: 'オフラインは未確認', edge });
function design() {
  let s = applyUser(initialState(), { type: 'resume' });
  for (const e of [{ type: 'goals', goal: '設計する', constraints: '' }, { type: 'issue', text: 'データの置き場所' }, { type: 'critique', text: 'サーバに保存する' }] as Edge[]) s = transition(s, next(e), observation);
  return s;
}

test('atomic edge failure never partially registers or confirms artifacts; draft freshness binds record and source', () => {
  const s = design();
  const before = structuredClone(s);
  // Draft creation would succeed, but starting is invalid outside the scope discussion.
  assert.throws(() => transition(s, next({ type: 'start', contract }), observation), /scope discussion/);
  assert.deepEqual(s, before);
  const invalid = { ...contract, expectations: [{ id: 'E1', text: 'a' }, { id: 'E1', text: 'b' }] };
  assert.throws(() => proposeNext(s, next({ type: 'scope', contract: invalid }), observation), /duplicate/);
  assert.deepEqual(s, before);
  const offered = proposeNext(s, next({ type: 'decide' }), observation);
  assert.ok(pendingNext(offered, observation));
  assert.equal(pendingNext(offered, other), undefined);
  assert.equal(pendingNext(offered, { ...observation, source: { ...observation.source!, root: '/other-repo' } }), undefined);
  const changed = applyUser(offered, { type: 'response', issueId: 1, text: '別の条件がある' });
  assert.equal(currentNext(changed, observation), undefined, 'stale proposal is not replaced with a different default action');
  assert.deepEqual(restore([{ type: 'custom', customType: 'mentor-state', data: offered }]).state, offered);
});

test('revision, experiment, design-return and correction loops preserve history and require explicit authority', () => {
  let s = design();
  const original = s.issues[0].revisions[0];
  s = transition(s, next({ type: 'revise', note: '条件を変える' }), observation);
  assert.equal(s.issues[0].inner, 'hypothesis');
  s = transition(s, next({ type: 'critique', text: 'ローカルキャッシュを併用する' }), observation);
  assert.deepEqual(s.issues[0].revisions[0], original);
  assert.equal(s.issues[0].revisions.length, 2);
  assert.equal(s.issues[0].judgments[0].revision, 1);
  s = transition(s, next({ type: 'scope', contract }), observation);
  assert.equal(s.units[0].phase, 'scope');
  assert.equal(s.issues[0].judgments.at(-1)?.decision, 'revise', 'experiment scope is not design adoption');
  s = transition(s, next({ type: 'start' }), observation);
  s = transition(s, next({ type: 'inspect' }), observation);
  s = transition(s, next({ type: 'correct', note: '実対象でも確認する' }), observation);
  assert.equal(s.units[0].phase, 'implementing');
  assert.equal(s.units[0].judgments.at(-1)?.decision, 'correction');
  assert.match(actionMeaning({ type: 'correct', note: '' }).effect, /明示的に許可/);
  s = transition(s, next({ type: 'design', note: '前提を見直す' }), observation);
  assert.equal(s.whole, 'explore');
  assert.equal(s.issues[0].inner, 'hypothesis');
  assert.equal(s.units[0].judgments.at(-1)?.decision, 'design');
  assert.equal(s.units[0].phase, 'judgment');
  assert.equal(s.issues[0].revisions.length, 2);
  assert.throws(() => transition(s, next({ type: 'start' }), observation), /scope discussion/);
});

test('newer saved revision is the explicit default target and exact repair works directly from judgment', () => {
  let s = design();
  s = transition(s, next({ type: 'revise', note: '見直す' }), observation);
  s = transition(s, next({ type: 'critique', text: '現在の案 r2' }), observation);
  s = applyModel(s, { type: 'critique', issueId: 1, revision: 2, category: 'uncertainty', text: '読者の条件', evidence: '読者が前提を知らない場合', status: 'open' });
  s = applyModel(s, { type: 'draft', issueId: 1, text: '読者の視点を加えた修正案 r3' });
  s = applyModel(s, { type: 'critique', issueId: 1, revision: 3, category: 'uncertainty', text: '修正案にも残る具体例の不足', evidence: '具体例が読者に通じない場合', status: 'open' });
  s = transition(s, next({ type: 'revise', note: '再検討' }), observation);
  const p = currentNext(s, observation)!;
  assert.deepEqual(p.edge, { type: 'critique', text: '読者の視点を加えた修正案 r3' });
  assert.notEqual(actionMeaning(p.edge, s).label, actionMeaning({ type: 'critique' }, s).label);
  assert.match(exactArtifact(s, p, observation), /今回の検討対象への記録:[\s\S]*修正案にも残る具体例の不足/);
  assert.match(exactArtifact(s, p, observation), /以前の案への記録[\s\S]*読者の条件/);
  assert.match(actionMeaning({ type: 'critique' }, s).effect, /変更せず/);
  s = transition(s, next({ type: 'critique' }), observation);
  s = transition(s, next({ type: 'decide' }), observation);
  const before = structuredClone(s);
  const planned = proposeNext(s, p, observation);
  assert.equal(planned.issues[0].currentRevision, 2, 'a proposal is not approval');
  const repaired = transition(s, p, observation);
  assert.doesNotMatch(operationFeedback(s, repaired, p, 'planned'), /適用しました|保持しました|記録していません/);
  assert.match(operationFeedback(s, repaired, p), /適用しました/);
  assert.equal(repaired.issues[0].currentRevision, 3);
  assert.equal(repaired.issues[0].revisions.length, 3, 'reuse exact saved draft');
  assert.equal(repaired.issues[0].inner, 'critique');
  assert.deepEqual(repaired.issues[0].critiques, before.issues[0].critiques);
  assert.deepEqual(repaired.issues[0].judgments, before.issues[0].judgments);
  assert.deepEqual(repaired.units, before.units);
  assert.deepEqual(s, before);
});

test('scope default start displays the newer saved contract instead of silently authorizing the old scope', () => {
  let s = transition(design(), next({ type: 'scope', contract }), observation);
  const revised = { ...contract, scope: '更新後の限定範囲' };
  s = applyModel(s, { type: 'unitDraft', unitId: 1, contract: revised }, observation);
  const p = currentNext(s, observation)!;
  assert.deepEqual(p.edge, { type: 'start', contract: revised });
  assert.match(exactArtifact(s, p, observation), /更新後の限定範囲/);
  assert.equal(s.units[0].phase, 'scope', 'offering the revised scope grants no implementation permission');
});

test('exact acceptance card retains payload, missing evidence and source limitations; unknown is not fresh', () => {
  let s = design();
  s = transition(s, next({ type: 'scope', contract }), observation);
  s = transition(s, next({ type: 'start' }), observation);
  s = transition(s, next({ type: 'inspect' }), observation);
  const p = next({ type: 'accept', note: '実環境未確認を留保' });
  const text = exactArtifact(s, p, { checkedAt: 'now', error: 'Git外' });
  for (const value of [contract.scope, contract.expectations[0].text, contract.verificationPlan, '鮮度不明', '証拠なし／不明', '実環境未確認を留保']) assert.ok(text.includes(value), value);
  s = transition(s, p, { checkedAt: 'now', error: 'Git外' });
  assert.equal(s.units[0].judgments.at(-1)?.source, null);
  assert.equal(s.issues[0].judgments.length, 0, 'experiment acceptance is not design adoption');
  assert.equal(currentNext(s, observation)?.edge.type, 'inspect', 'unknown acceptance does not become current acceptance later');
});
