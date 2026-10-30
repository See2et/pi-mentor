import { Value } from 'typebox/value';
import { applyModel, applyUser, concerns, currentRevision, currentJudgment, issueById, type State, type UserAction } from './domain.ts';
import { NextSchema, type Edge, type Next } from './guided-schema.ts';
import { contractText, evidenceFreshness, unitById, unitDetails, unitJudgment, unitRevision, type Observation } from './units.ts';

export const sourceIdentity = (o?: Observation) => o?.source ? `${o.source.root}:${o.source.hash}` : `unknown:${o?.error ?? 'not observed'}`;
const require = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };
export const activeIssue = (s: State) => s.activeIssue === null ? undefined : issueById(s, s.activeIssue);
export const activeUnit = (s: State) => s.activeUnit === null ? undefined : unitById(s, s.activeUnit);

// All user edges are planned on a private clone. No append, UI, or await occurs in this reducer.
export function transition(state: State, proposal: Next, observation?: Observation): State {
  require(state.enabled, 'Mentor is paused. Resume explicitly with /mentor.');
  require(Value.Check(NextSchema, proposal), 'Invalid next-action draft.');
  let s = structuredClone(state);
  const e = proposal.edge;
  const i = activeIssue(s);
  const u = activeUnit(s);
  const user = (a: UserAction) => { s = applyUser(s, a, observation); };
  const model = (a: Parameters<typeof applyModel>[1]) => { s = applyModel(s, a, observation); };
  const explore = () => require(s.whole === 'explore' && i, 'This action needs the current design discussion.');
  const implementation = () => require(s.whole === 'implementation' && u, 'This action needs the current implementation scope.');
  switch (e.type) {
    case 'goals':
      require(s.whole === 'goals', 'Return to the goal discussion first.');
      user({ type: 'goal', text: e.goal }); user({ type: 'constraints', text: e.constraints });
      user({ type: 'phase', whole: 'issues' }); break;
    case 'issue': {
      require(['issues', 'consistency', 'summary'].includes(s.whole), 'Choose an issue from the issue or whole-review discussion.');
      let id = e.issueId;
      if (id !== undefined) require(issueById(s, id).text === e.text, 'Issue text changed; prepare a fresh card.');
      else { user({ type: 'issue', text: e.text }); id = s.issues.length; }
      user({ type: 'select', issueId: id });
      user({ type: 'phase', whole: 'explore', inner: 'hypothesis' }); break;
    }
    case 'critique': {
      explore();
      require(i!.inner === 'hypothesis' || i!.inner === 'critique', 'Return to forming the proposal before changing the review target.');
      const r = currentRevision(i!);
      if (e.text !== undefined && e.text !== r?.text) {
        model({ type: 'draft', issueId: i!.id, text: e.text });
        user({ type: 'confirmDraft', issueId: i!.id, revision: issueById(s, i!.id).revisions.length });
      }
      require(currentRevision(issueById(s, i!.id))?.confirmed, 'Organize an exact proposal before examining it.');
      user({ type: 'phase', whole: 'explore', inner: 'critique' }); break;
    }
    case 'decide':
      explore(); require(i!.inner === 'critique' && currentRevision(i!), 'Examine the chosen proposal before deciding direction.');
      user({ type: 'phase', whole: 'explore', inner: 'judgment' }); break;
    case 'adopt':
      explore(); require(i!.inner === 'judgment', 'Discuss the direction decision first.');
      user({ type: 'judge', issueId: i!.id, decision: 'adopt', note: e.note });
      user({ type: 'phase', whole: 'implementation' });
      s.activeUnit = null; // A design decision must not re-authorize an earlier implementation unit.
      break;
    case 'revise':
      explore();
      user({ type: 'judge', issueId: i!.id, decision: 'revise', note: e.note });
      user({ type: 'phase', whole: 'explore', inner: 'hypothesis' }); break;
    case 'scope': {
      require(s.whole !== 'implementation' || !u || u.phase !== 'implementing', 'Stop or inspect the current implementation before changing scope.');
      model({ type: 'unitDraft', contract: e.contract });
      const id = s.units.length;
      user({ type: 'selectUnit', unitId: id });
      user({ type: 'confirmUnit', unitId: id, revision: 1 });
      user({ type: 'phase', whole: 'implementation' }); break;
    }
    case 'start': {
      require(s.whole === 'implementation' && (!u || u.phase === 'scope'), 'Implementation can start only from scope discussion.');
      let id = u?.id;
      if (e.contract) {
        model({ type: 'unitDraft', unitId: id, contract: e.contract });
        id ??= s.units.length;
        user({ type: 'confirmUnit', unitId: id, revision: unitById(s, id).revisions.length });
      }
      require(id !== undefined && unitRevision(unitById(s, id))?.confirmed, 'Organize the exact scope, expectations and check plan first.');
      user({ type: 'selectUnit', unitId: id! });
      user({ type: 'unitPhase', unitId: id!, phase: 'implementing' }); break;
    }
    case 'inspect':
      implementation(); require(u!.phase === 'implementing' || u!.phase === 'judgment', 'Inspect a result after explicit implementation, or re-inspect a past judgment.');
      user({ type: 'unitPhase', unitId: u!.id, phase: 'examination' }); break;
    case 'accept':
      implementation(); require(u!.phase === 'examination' || u!.phase === 'judgment', 'Inspect the result before accepting it.');
      user({ type: 'unitPhase', unitId: u!.id, phase: 'judgment' });
      user({ type: 'unitJudge', unitId: u!.id, decision: 'accept', note: e.note }); break;
    case 'correct':
      implementation(); require(u!.phase === 'examination' || u!.phase === 'judgment', 'Request correction after inspecting the result.');
      user({ type: 'unitPhase', unitId: u!.id, phase: 'judgment' });
      user({ type: 'unitJudge', unitId: u!.id, decision: 'correction', note: e.note });
      user({ type: 'unitPhase', unitId: u!.id, phase: 'implementing' }); break;
    case 'design':
      require(s.whole === 'implementation', 'Return to design from implementation discussion.');
      if (u) {
        user({ type: 'unitPhase', unitId: u.id, phase: 'judgment' });
        user({ type: 'unitJudge', unitId: u.id, decision: 'design', note: e.note });
      }
      user({ type: 'phase', whole: i ? 'explore' : 'issues', ...(i ? { inner: 'hypothesis' as const } : {}) }); break;
    case 'defer':
      if (s.whole === 'implementation') {
        implementation(); user({ type: 'unitPhase', unitId: u!.id, phase: 'judgment' });
        user({ type: 'unitJudge', unitId: u!.id, decision: 'defer', note: e.note });
      } else { explore(); user({ type: 'judge', issueId: i!.id, decision: 'defer', note: e.note }); }
      user({ type: 'phase', whole: 'issues' }); break;
    case 'review': user({ type: 'phase', whole: 'consistency' }); break;
    case 'finish':
      require(s.whole === 'consistency' || s.whole === 'summary', 'Review the whole work before finishing.');
      user({ type: 'phase', whole: 'summary' }); user({ type: 'pause' }); break;
    case 'revisitGoals': user({ type: 'phase', whole: 'goals' }); break;
    case 'switchIssue':
      user({ type: 'select', issueId: e.issueId });
      user({ type: 'phase', whole: 'explore' }); break;
    case 'switchUnit':
      user({ type: 'selectUnit', unitId: e.unitId });
      user({ type: 'phase', whole: 'implementation' });
      // Switching to a past scope never restarts its implementation permission.
      if (unitById(s, e.unitId).phase === 'implementing') user({ type: 'unitPhase', unitId: e.unitId, phase: 'scope' });
      break;
    default: throw new Error('Unknown next action.');
  }
  s.sequence = state.sequence + 1;
  s.guided = { history: [...(state.guided?.history ?? []), { sequence: s.sequence, proposal: structuredClone(proposal) }] };
  return s;
}

export function proposeNext(state: State, proposal: Next, observation?: Observation): State {
  transition(state, proposal, observation); // Validate the complete edge without adopting or advancing it.
  const s = structuredClone(state);
  s.sequence++;
  s.guided = { history: s.guided?.history ?? [], pending: { sequence: s.sequence, source: sourceIdentity(observation), proposal: structuredClone(proposal) } };
  return s;
}
export function pendingNext(s: State, o?: Observation): Next | undefined {
  const p = s.guided?.pending;
  if (!p || p.sequence !== s.sequence || p.source !== sourceIdentity(o)) return undefined;
  return p.proposal as Next;
}
export function defaultNext(s: State, o?: Observation): Next | undefined {
  if (!s.enabled) return undefined;
  const i = activeIssue(s), u = activeUnit(s);
  let edge: Edge | undefined;
  if (s.whole === 'explore' && i && currentRevision(i)) {
    edge = i!.inner === 'hypothesis' ? { type: 'critique' } : i!.inner === 'critique' ? { type: 'decide' } : undefined;
  } else if (s.whole === 'implementation' && u) {
    if (u.phase === 'scope' && unitRevision(u)) edge = { type: 'start' };
    else if (u.phase === 'implementing') edge = { type: 'inspect' };
    else if (u.phase === 'examination') edge = { type: 'accept', note: '' };
    else if (u.phase === 'judgment') edge = unitJudgment(u, o)?.decision === 'accept' ? { type: 'review' } : { type: 'inspect' };
  } else if (s.whole === 'consistency' || s.whole === 'summary') edge = { type: 'finish' };
  return edge ? { summary: '現在の記録を対象に進めます。', unresolved: '', edge } : undefined;
}
export function currentNext(s: State, o?: Observation): Next | undefined {
  // A stale model card is not silently replaced with a different default edge.
  return s.guided?.pending ? pendingNext(s, o) : defaultNext(s, o);
}
export function workTitle(s: State): string {
  if (!s.enabled) return 'Mentor 一時停止 · /mentor で再開';
  const i = activeIssue(s), u = activeUnit(s);
  if (s.whole === 'implementation') return u ? `${unitRevision(u)?.contract.title ?? '実装範囲'}を${{ scope: '具体化する', implementing: '実装・確認する', examination: '結果から確かめる', judgment: '判断する' }[u.phase]}` : '採用した方向の実装範囲を具体化する（まだ開始しない）';
  if (s.whole === 'explore' && i) return `${i.text}：${{ hypothesis: '案を考える', critique: '前提と弱点を検討する', judgment: '方向を決める' }[i.inner]}`;
  const wholeTitles: Partial<Record<State['whole'], string>> = { goals: '目標と制約を整理する', issues: '次に考える論点を選ぶ', consistency: '全体のつながりを見直す', summary: '決定と残った課題をまとめる' };
  return wholeTitles[s.whole] ?? '現在の相談';
}
export function actionMeaning(e: Edge): { label: string; effect: string } {
  switch (e.type) {
    case 'goals': return { label: 'この目標・制約で論点を考える', effect: '表示した目標と制約を記録し、論点を選ぶ相談へ進みます。' };
    case 'issue': return { label: 'この論点の案を考える', effect: '表示した論点を現在の検討対象にします。仮説の採用ではありません。' };
    case 'critique': return { label: 'この案を批判・弁護してみる', effect: '表示した正確な案を検討対象として記録し、前提と弱点を調べます。採用・実装許可ではありません。' };
    case 'decide': return { label: 'この案の採否を考える', effect: '同じ案と懸念をもとに方向を決める相談へ進みます。まだ採用しません。' };
    case 'adopt': return { label: 'この方向を暫定採用し、範囲を考える', effect: '現在の案を暫定採用として記録します。実装は許可しません。次に範囲を具体化します。' };
    case 'revise': return { label: 'この案を練り直す', effect: '修正する判断を記録し、案を考える相談へ戻ります。過去の案・批判は残します。' };
    case 'scope': return { label: e.contract.kind === 'experiment' ? 'この実験の範囲を検討する' : 'この実装範囲を検討する', effect: '表示した範囲・期待・検証計画を記録します。まだ実装・実験を開始せず、設計の採用も変えません。' };
    case 'start': return { label: 'この範囲で実装・検証を始める', effect: '表示した正確な範囲・期待・非目標・検証計画を確定し、この単位だけの実装・検証を明示的に許可します。' };
    case 'inspect': return { label: 'この結果を確かめる', effect: '実装を止め、表示した契約・観測・証拠・限界を照合する相談へ進みます。受け入れではありません。' };
    case 'accept': return { label: 'この結果を留保込みで受け入れる', effect: '表示した契約・最終観測ソース・証拠・不足と留保に紐づく受け入れを記録します。次の実装は開始しません。実験の受入は設計・機能採用ではありません。' };
    case 'correct': return { label: 'この範囲の修正を始める', effect: '修正依頼を記録し、表示した現契約の範囲だけの実装・検証を再び明示的に許可します。範囲を変えるなら先に設計へ戻ってください。' };
    case 'design': return { label: '実装を止めて設計に戻る', effect: '設計に戻る判断を記録し、案を考える相談に戻ります。実装は再開しません。' };
    case 'defer': return { label: 'この検討を保留する', effect: '現在の対象に保留を記録して、論点を選ぶ相談へ戻ります。他の作業は開始しません。' };
    case 'review': return { label: '全体のつながりを見直す', effect: '全体の目標・各判断・残った課題を照合する相談へ進みます。採否や受け入れは変えません。' };
    case 'finish': return { label: 'ここまでを区切り、通常チャットへ戻る', effect: 'まとめの位置でMentorを一時停止します。未解決事項の解決・採用・受け入れを意味しません。履歴は残ります。' };
    case 'revisitGoals': return { label: '目標と制約を見直す', effect: '目標と制約の相談に戻ります。実装の開始・再開は許可しません。' };
    case 'switchIssue': return { label: 'この論点の相談に戻る', effect: '表示した論点の、最後に選んだ検討内容に戻ります。判断は変更しません。' };
    case 'switchUnit': return { label: 'この作業の相談に戻る', effect: '表示した単位の相談に戻ります。実装中だった単位も範囲の確認に戻し、実装を自動再開しません。' };
  }
}
export function exactArtifact(s: State, p: Next, o?: Observation): string {
  const e = p.edge, i = activeIssue(s), u = activeUnit(s);
  let artifact = '';
  if (e.type === 'goals') artifact = `目標:\n${e.goal}\n\n制約:\n${e.constraints || 'なし'}`;
  else if (e.type === 'issue') artifact = `検討する論点:\n${e.text}`;
  else if (e.type === 'scope' || (e.type === 'start' && e.contract)) {
    const c = e.contract!;
    artifact = `種類: ${c.kind === 'experiment' ? '仮説実験（設計採用ではない）' : '機能実装'}\n題名: ${c.title}\n目的: ${c.purpose}\n設計参照:\n${c.designRefs.join('\n')}\n範囲:\n${c.scope}\n期待:\n${c.expectations.map(x => `${x.id}: ${x.text}`).join('\n')}\n非目標:\n${c.nonGoals}\n検証計画:\n${c.verificationPlan}`;
  } else if (e.type === 'switchIssue') {
    const target = issueById(s, e.issueId);
    artifact = `論点: ${target.text}\n案:\n${currentRevision(target)?.text ?? 'まだなし'}\n現在の判断: ${currentJudgment(target)?.decision ?? '未判断'}`;
  } else if (e.type === 'switchUnit') artifact = unitDetails(unitById(s, e.unitId), o);
  else if (s.whole === 'implementation' && u) artifact = e.type === 'start' ? contractText(u) : unitDetails(u, o);
  else if (i && s.whole === 'explore') artifact = `論点: ${i.text}\n\n検討対象の正確な案:\n${e.type === 'critique' && e.text !== undefined ? e.text : currentRevision(i)?.text ?? 'まだなし'}\n\n${e.type === 'critique' && e.text !== undefined && e.text !== currentRevision(i)?.text ? '以前の案への懸念（今回の案へ自動継承しません）' : '未撤回の懸念（根拠・条件付き）'}:\n${concerns(i).map(c => `[${c.category}] ${c.text}\n${c.evidence}`).join('\n\n') || '記録なし（正しさの保証ではありません）'}\n\n${e.type === 'critique' && e.text !== undefined && e.text !== currentRevision(i)?.text ? '以前の案への弁護・応答（今回の案へ自動継承しません）' : '弁護・応答'}:\n${i.responses.filter(r => r.revision === i.currentRevision).map(r => `[${r.author}] ${r.text}`).join('\n\n') || '記録なし'}`;
  else artifact = `目標: ${s.goal || '未設定'}\n制約: ${s.constraints || '未設定'}\n\n${s.issues.map(i => `${i.text}\n案: ${currentRevision(i)?.text ?? 'なし'}\n判断: ${currentJudgment(i)?.decision ?? '未判断'}\n残った懸念: ${concerns(i).map(c => c.text).join(' / ') || '記録なし'}`).join('\n\n')}\n\n${s.units.map(u => `${unitRevision(u)?.contract.title ?? '未確認の範囲'}: ${unitJudgment(u, o)?.decision ?? '現在の受け入れなし'} / ${evidenceFreshness(u, o)}`).join('\n')}`;
  return `${p.summary}\n\n未解決・留保:\n${p.unresolved || '追加の記載なし（解決済みの保証ではありません）'}\n\n${artifact}${'note' in e ? `\n\n今回記録する理由・留保（AI整理、選択により本人判断）:\n${e.note || '追記なし'}` : ''}`;
}
