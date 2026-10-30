import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyUser, applyModel, initialState, restore, location, mentorContext, compactRecord } from '../src/domain.ts';
import { unitJudgment, unitDetails, evidenceFreshness, type Contract, type Observation } from '../src/units.ts';
import { widgetLines } from '../src/presentation.ts';
import { visibleWidth } from '@earendil-works/pi-tui';

const contract: Contract = { kind: 'feature', title: '入力境界', purpose: '不正入力を拒否する', designRefs: ['issue #1 r1 / API仕様'], scope: '入力処理', expectations: [{ id: 'E1', text: '長すぎる入力を拒否する' }], nonGoals: 'UI変更', verificationPlan: '境界入力を実際に送る' };
const source: Observation = { checkedAt: 'now', source: { hash: 'a'.repeat(64), root: '/repo', checkedAt: 'now' } };
const changed: Observation = { checkedAt: 'later', source: { hash: 'b'.repeat(64), root: '/repo', checkedAt: 'later' } };
function setup() {
  let s = applyUser(initialState(), { type: 'resume' });
  s = applyUser(s, { type: 'phase', whole: 'implementation' });
  s = applyUser(s, { type: 'unitContract', contract });
  return applyUser(s, { type: 'selectUnit', unitId: 1 });
}
const evidence = { type: 'unitEvidence' as const, unitId: 1, revision: 1, sourceHash: source.source!.hash, entries: [{ expectationId: 'E1', observation: '長すぎる入力が拒否された', references: ['node check.ts; exit 0'], method: 'real' as const, limitations: '本番依存は未確認' }], concerns: '本番依存の挙動は未知' };
test('implementation is a human-selectable whole activity, independent of design completion', () => {
  const s = applyUser(applyUser(initialState(), { type: 'resume' }), { type: 'phase', whole: 'implementation' });
  assert.equal(s.whole, 'implementation');
});
test('AI drafts cannot select or start a unit; exact human confirmation binds a contract, not a judgment', () => {
  let s = applyUser(initialState(), { type: 'resume' });
  s = applyModel(s, { type: 'unitDraft', contract });
  assert.equal(s.activeUnit, null);
  assert.equal(s.units[0].currentRevision, null);
  for (const type of ['unitJudge', 'unitPhase', 'confirmUnit', 'selectUnit']) assert.throws(() => applyModel(s, { type, unitId: 1 } as never), /not permitted/);
  s = applyUser(s, { type: 'selectUnit', unitId: 1 });
  s = applyUser(s, { type: 'phase', whole: 'implementation' });
  assert.throws(() => applyUser(s, { type: 'unitPhase', unitId: 1, phase: 'implementing' }), /Confirm/);
  s = applyUser(s, { type: 'confirmUnit', unitId: 1, revision: 1 });
  assert.equal(s.units[0].phase, 'scope');
  assert.equal(s.units[0].judgments.length, 0);
});
test('evidence binds valid expectation IDs, contract revision and observed code; ready/test results never advance phase or decide', () => {
  let s = setup();
  assert.throws(() => applyModel(s, evidence), /snapshot/);
  assert.throws(() => applyModel(s, evidence, changed), /snapshot/);
  assert.throws(() => applyModel(s, { ...evidence, entries: [{ ...evidence.entries[0], expectationId: 'E99' }] }, source), /expectation IDs/);
  s = applyModel(s, evidence, source);
  s = applyModel(s, { type: 'unitReport', unitId: 1, revision: 1, text: '準備完了・テスト成功。ただし本番未検証' });
  assert.equal(s.units[0].phase, 'scope');
  assert.equal(s.units[0].judgments.length, 0);
  assert.match(evidenceFreshness(s.units[0], source), /最終確認時一致/);
  assert.match(evidenceFreshness(s.units[0], changed), /古い/);
  assert.match(evidenceFreshness(s.units[0]), /不明/);
  s = applyUser(s, { type: 'unitContract', unitId: 1, contract: { ...contract, expectations: [{ id: 'E2', text: '空入力も拒否する' }] } });
  assert.equal(s.units[0].evidence.length, 1);
  assert.match(evidenceFreshness(s.units[0], source), /古い/);
  assert.throws(() => applyModel(s, evidence, source), /revision changed/);
});
test('human judgment has no evidence/understanding pass gate; revisions and source changes never inherit acceptance; corrections and notes persist', () => {
  let s = setup();
  s = applyUser(s, { type: 'unitPhase', unitId: 1, phase: 'judgment' });
  s = applyUser(s, { type: 'unitJudge', unitId: 1, decision: 'accept', note: '証拠なし・本番は未知のまま受け入れる' }, source);
  assert.equal(unitJudgment(s.units[0], source)?.decision, 'accept');
  assert.equal(unitJudgment(s.units[0], changed), undefined);
  assert.equal(unitJudgment(s.units[0]), undefined);
  s = applyUser(s, { type: 'unitJudge', unitId: 1, decision: 'correction', note: '実対象の証拠がほしい' }, changed);
  s = applyUser(s, { type: 'unitPhase', unitId: 1, phase: 'implementing' });
  s = applyUser(s, { type: 'unitNote', unitId: 1, text: 'なぜこの境界で検証するのか調べる' });
  s = applyModel(s, { type: 'unitSuggestion', unitId: 1, revision: 1, text: '入力経路を追ってみる提案' });
  s = applyUser(s, { type: 'unitContract', unitId: 1, contract: { ...contract, scope: '境界と呼出元' } });
  assert.equal(s.units[0].judgments.length, 2);
  assert.equal(s.units[0].notes[0].author, 'human');
  assert.equal(s.units[0].notes[1].author, 'ai');
  assert.equal(s.units[0].phase, 'scope');
  assert.equal(unitJudgment(s.units[0], source), undefined);
  assert.match(location(s, source).join('\n'), /未判断/);
  assert.match(mentorContext(s, source)!, /never automatic expectation satisfaction/);
});
test('experiment acceptance is not design adoption, defer needs no implementation, return to design is explicitly human', () => {
  let s = setup();
  s = applyUser(s, { type: 'unitContract', unitId: 1, contract: { ...contract, kind: 'experiment' } });
  s = applyUser(s, { type: 'unitPhase', unitId: 1, phase: 'judgment' });
  s = applyUser(s, { type: 'unitJudge', unitId: 1, decision: 'defer', note: '' });
  assert.equal(s.whole, 'implementation');
  assert.equal(s.units[0].judgments[0].source, null);
  s = applyUser(s, { type: 'unitJudge', unitId: 1, decision: 'accept', note: '' }, source);
  assert.equal(s.issues.length, 0);
  assert.equal(s.units[0].phase, 'judgment');
  s = applyUser(s, { type: 'unitJudge', unitId: 1, decision: 'design', note: '前提を再検討する' }, source);
  assert.equal(s.whole, 'issues');
  assert.equal(s.activeUnit, 1);
  assert.equal(s.units[0].judgments.length, 3);
});
test('latest human judgment is never bypassed when source observation returns', () => {
  const unavailable: Observation = { checkedAt: 'offline', error: 'Git unavailable' };
  for (const decision of ['correction', 'defer'] as const) {
    for (const laterSource of [unavailable, changed]) {
      let s = applyUser(setup(), { type: 'unitPhase', unitId: 1, phase: 'judgment' });
      s = applyUser(s, { type: 'unitJudge', unitId: 1, decision: 'accept', note: 'At A' }, source);
      s = applyUser(s, { type: 'unitJudge', unitId: 1, decision, note: 'Latest human choice' }, laterSource);
      assert.equal(unitJudgment(s.units[0], source), undefined, 'Do not resurrect acceptance at A');
      const record = compactRecord(s, source).units[0];
      assert.equal(record.judgment, undefined);
      assert.equal(record.latestJudgment?.decision, decision);
      assert.match(record.judgmentStatus, laterSource.source ? /不一致/ : /不明/);
      const display = location(s, source).join('\n');
      assert.match(display, decision === 'correction' ? /修正を依頼する/ : /保留する/);
      assert.doesNotMatch(display, /このスコープを受け入れる/);
      assert.ok(mentorContext(s, source)!.includes(record.judgmentStatus));
      assert.ok(unitDetails(s.units[0], source).includes(record.judgmentStatus));
      assert.ok(widgetLines(s, 120, undefined, source).join('').includes(record.judgmentStatus));
      for (const line of widgetLines(s, 36, undefined, source)) assert.ok(visibleWidth(line) <= 36);
      assert.equal(s.units[0].judgments.length, 2);
    }
  }
});
test('operative unit guidance distinguishes confirmation, explicit start, examination and judgment', () => {
  const operative = (s: ReturnType<typeof initialState>) => mentorContext(s, source)!.split('AT THIS PHASE: ')[1].split('\nCURRENT LOCATION')[0];
  let s = applyUser(applyUser(initialState(), { type: 'resume' }), { type: 'phase', whole: 'implementation' });
  assert.match(operative(s), /No active unit/);
  s = applyModel(s, { type: 'unitDraft', contract });
  s = applyUser(s, { type: 'selectUnit', unitId: 1 });
  s = applyUser(s, { type: 'confirmUnit', unitId: 1, revision: 1 });
  assert.equal(s.units[0].phase, 'scope');
  assert.match(operative(s), /Contract confirmation is not implementation authorization/);
  assert.match(operative(s), /explicitly start/);
  s = applyUser(s, { type: 'unitPhase', unitId: 1, phase: 'implementing' });
  assert.match(operative(s), /Use normal Pi tools to implement and check/);
  assert.match(operative(s), /Do not start another unit/);
  for (const phase of ['examination', 'judgment'] as const) {
    s = applyUser(s, { type: 'unitPhase', unitId: 1, phase });
    assert.match(operative(s), /Do not continue implementation/);
    assert.match(operative(s), phase === 'examination' ? /Inspect observations/ : /Support the human decision/);
    assert.doesNotMatch(operative(s), /Use normal Pi tools to implement and check/);
  }
});
test('schema1 migration preserves design histories; current units restore; corrupt expectation bindings block mutation', () => {
  let legacy = applyUser(initialState(), { type: 'resume' });
  legacy = applyUser(legacy, { type: 'issue', text: '既存論点' });
  legacy = applyUser(legacy, { type: 'hypothesis', issueId: 1, text: '既存仮説' });
  legacy = applyModel(legacy, { type: 'critique', issueId: 1, revision: 1, category: 'uncertainty', text: '未確認', evidence: '外部条件', status: 'open' });
  legacy = applyUser(legacy, { type: 'judge', issueId: 1, decision: 'adopt', note: '留保あり' });
  const { units, activeUnit, ...old } = legacy;
  const entry = (data: unknown) => ({ type: 'custom', customType: 'mentor-state', data });
  const migrated = restore([entry({ ...old, schema: 1 })]);
  assert.equal(migrated.error, undefined);
  assert.deepEqual(migrated.state.issues, legacy.issues);
  assert.deepEqual(migrated.state.units, []);
  const current = applyModel(setup(), evidence, source);
  assert.deepEqual(restore([entry(current)]).state, current);
  current.units[0].evidence[0].entries[0].expectationId = 'not-a-contract-expectation';
  assert.match(restore([entry(current)]).error!, /invalid/);
});
