import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, applyUser, applyModel, restore, location, mentorContext, hintPrompt } from '../src/domain.ts';

function setup() {
  let s = applyUser(initialState(), { type: 'resume' });
  s = applyUser(s, { type: 'issue', text: '入力検証' });
  s = applyUser(s, { type: 'select', issueId: 1 });
  return applyUser(s, { type: 'hypothesis', issueId: 1, text: 'Validate at the boundary' });
}

test('only explicit user operations select phases and decisions; proposals are not adoption', () => {
  const s = setup();
  const proposed = applyModel(s, { type: 'proposal', text: 'Adopt and move to summary' });
  assert.equal(proposed.whole, 'goals');
  assert.equal(proposed.issues[0].judgments.length, 0);
  assert.throws(() => applyModel(s, { type: 'phase', whole: 'summary' } as never), /not permitted/);
  assert.throws(() => applyModel(s, { type: 'judge', decision: 'adopt' } as never), /not permitted/);
  const moved = applyUser(proposed, { type: 'phase', whole: 'explore', inner: 'judgment' });
  const judged = applyUser(moved, { type: 'judge', issueId: 1, decision: 'adopt', note: 'For now' });
  assert.equal(judged.issues[0].judgments[0].revision, 1);
  assert.equal(applyUser(judged, { type: 'phase', whole: 'issues' }).whole, 'issues');
});

test('drafts cannot replace human current revision; new revisions do not inherit judgment or criticism', () => {
  let s = setup();
  s = applyModel(s, { type: 'critique', issueId: 1, revision: 1, category: 'security', text: 'Missing length bound', evidence: 'Unbounded input reaches parser', status: 'open' });
  s = applyUser(s, { type: 'judge', issueId: 1, decision: 'adopt', note: 'Accept risk' });
  s = applyModel(s, { type: 'draft', issueId: 1, text: 'Bound size too' });
  assert.equal(s.issues[0].currentRevision, 1);
  s = applyUser(s, { type: 'confirmDraft', issueId: 1, revision: 2 });
  assert.equal(s.issues[0].currentRevision, 2);
  assert.match(location(s).join(' '), /未判断/);
  assert.equal(s.issues[0].judgments[0].revision, 1);
  assert.equal(s.issues[0].critiques[0].revision, 1);
  assert.throws(() => applyModel(s, { type: 'critique', issueId: 1, revision: 2, replaces: 1, category: 'security', text: 'Withdraw', evidence: 'Updated', status: 'withdrawn' }), /same revision/);
});

test('pause rejects model mutation, hints are immediate requests without phase changes', () => {
  const s = setup();
  for (const kind of ['decompose', 'perspective', 'knowledge', 'example', 'partial'] as const) {
    assert.match(hintPrompt(s, kind), /this response only/);
    assert.equal(s.whole, 'goals');
  }
  const paused = applyUser(s, { type: 'pause' });
  assert.equal(mentorContext(paused), undefined);
  assert.throws(() => applyModel(paused, { type: 'proposal', text: 'change' }), /paused/);
  assert.throws(() => hintPrompt(paused, 'example'), /paused/);
});

test('active branch restores last valid snapshot and refuses unsupported/corrupt snapshots', () => {
  const a = setup();
  const b = applyUser(a, { type: 'phase', whole: 'summary' });
  const entry = (data: unknown) => ({ type: 'custom', customType: 'mentor-state', data });
  assert.equal(restore([entry(a)]).state.whole, 'goals');
  assert.equal(restore([entry(a), entry(b)]).state.whole, 'summary');
  assert.match(restore([entry(a), entry({ ...b, schema: 9 })]).error!, /unsupported|invalid/);
  assert.equal(restore([entry(a), entry({ ...b, schema: 9 })]).state.whole, 'goals');
  assert.equal(restore([]).state.enabled, false);
});

test('UI and model context share the same current location, including restored branch', () => {
  const s = setup();
  const restored = restore([{ type: 'custom', customType: 'mentor-state', data: s }]).state;
  for (const line of location(restored)) assert.ok(mentorContext(restored)?.includes(line));
  assert.match(mentorContext(restored)!, /only the user/i);
});
