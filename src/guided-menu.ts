import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { details, type State } from './domain.ts';
import { actionCard } from './card.ts';
import { actionMeaning, activeIssue, activeUnit, currentNext, exactArtifact, transition, workTitle } from './guided.ts';
import type { Edge, Next } from './guided-schema.ts';
import { mentorMenu, type MenuOwner } from './menu.ts';
import { inspect } from './viewer.ts';
import { selectMenu } from './navigation.ts';

export interface GuidedOwner extends MenuOwner { edge(proposal: Next, token: string): void }
export async function guidedMenu(ctx: ExtensionCommandContext, owner: GuidedOwner): Promise<void> {
  const before = owner.token();
  if (!ctx.isIdle()) {
    ctx.ui.notify('Mentor: 現在の応答の終了を待っています。', 'info');
    await ctx.waitForIdle();
    if (before.split('/').slice(0, 2).join('/') !== owner.token().split('/').slice(0, 2).join('/')) throw new Error('Session/branch changed while waiting. Open /mentor again.');
  }
  const token = owner.token(), s = owner.state(), o = owner.observation();
  if (owner.error()) { await mentorMenu('', ctx, owner); return; }
  const choose = async (title: string, entries: [string, string][]) => {
    const value = await selectMenu(ctx, title, entries.map(([, label]) => label));
    owner.check(token);
    return entries.find(([, label]) => value === label)?.[0];
  };
  if (!s.enabled) {
    const choice = await choose(workTitle(s), [['continue', '通常チャットを続ける'], ['resume', 'Mentor を開始・再開'], ['history', '履歴を見る']]);
    if (choice === 'resume') owner.user({ type: 'resume' }, token);
    else if (choice === 'history') { await inspect(ctx, 'Mentor 全記録・履歴', details(s, o)); owner.check(token); }
    return;
  }
  let proposal = currentNext(s, o);
  const organize = () => owner.ask('[Mentor: organize next action]\nContinue our current discussion without advancing it. Help me with a suitable graduated hint or a focused question, then organize the current artifact and unresolved matters. When concrete enough, use mentor_next with the latest snapshot to prepare ONE meaningful next-action card. This request does not select an edge, adopt anything, authorize implementation or accept a result.');
  for (;;) {
    const meaning = proposal && actionMeaning(proposal.edge, s);
    const body = proposal ? `次にすること: ${meaning!.label}\n選ぶと: ${meaning!.effect}\n\n候補（詳細はスクロール）:\n${exactArtifact(s, proposal, o)}` : `ここでは普通のチャットで相談を続けます。\n${s.guided?.pending ? '前の候補は記録またはコードが変わったため使えません。整理し直してください。' : '次の一手はまだ整理されていません。AIが会話から目標・案・未解決事項をまとめます。'}\n\n「次の一手を一緒に整理する」は相談だけを始め、何も確定しません。ヒントや別の進み方は「その他…」から選べます。`;
    const selected = await actionCard(ctx, workTitle(s), body, meaning?.label ?? '次の一手を一緒に整理する');
    owner.check(token);
    if (selected === 'edge') {
      if (proposal) owner.edge(proposal, token);
      else organize();
      return;
    }
    if (selected !== 'other') return;
    const alternatives = alternativeEdges(s).filter(edge => {
      try { transition(s, { summary: '進み方を変更します。', unresolved: '', edge }, o); return true; }
      catch { return false; }
    });
    const options: [string, string][] = [
      ['back', 'カードに戻る'], ['hint', '今回だけのヒントを依頼'], ['organize', '別の進み方を相談する（変更なし）'],
      ...('note' in (proposal?.edge ?? {}) ? [['note', '今回記録する理由・留保を編集'] as [string, string]] : []),
      ...alternatives.map((e, n): [string, string] => [`alt:${n}`, actionMeaning(e, s).label]),
      ['topics', '別の論点・作業の相談に戻る…'], ['history', '全記録・履歴を見る'], ['pause', 'Mentor を一時停止する'],
    ];
    const choice = await choose('その他（選ぶまでは変更しません）', options);
    if (!choice) return;
    if (choice === 'back') continue;
    if (choice === 'hint') { await mentorMenu('hint', ctx, owner); return; }
    if (choice === 'organize') { organize(); return; }
    if (choice === 'pause') { owner.user({ type: 'pause' }, token); return; }
    if (choice === 'note' && proposal && 'note' in proposal.edge) {
      const note = await ctx.ui.editor('今回の判断に残す理由・留保（Esc取消）', proposal.edge.note);
      owner.check(token);
      if (note !== undefined) proposal = { ...proposal, edge: { ...proposal.edge, note } };
      continue;
    }
    if (choice === 'history') {
      if (!await inspect(ctx, 'Mentor 全記録・履歴', details(s, o))) { owner.check(token); return; }
      owner.check(token); continue;
    }
    if (choice.startsWith('alt:')) {
      proposal = { summary: '進み方を変更します。', unresolved: '', edge: alternatives[Number(choice.slice(4))] };
      continue;
    }
    if (choice === 'topics') {
      const entries: [string, string][] = [['back', 'カードに戻る'], ...s.issues.map(i => [`i:${i.id}`, `論点 ${i.id}: ${i.text}`] as [string, string]), ...s.units.map(u => [`u:${u.id}`, `作業 ${u.id}: ${u.revisions.find(r => r.revision === u.currentRevision)?.contract.title ?? '未確認の範囲'}`] as [string, string])];
      const target = await choose('戻る相談を選ぶ（ここでは未確定）', entries);
      if (!target) return;
      if (target !== 'back') proposal = { summary: '以前の相談を再開します。', unresolved: '', edge: target.startsWith('i:') ? { type: 'switchIssue', issueId: Number(target.slice(2)) } : { type: 'switchUnit', unitId: Number(target.slice(2)) } };
    }
  }
}
function alternativeEdges(s: State): Edge[] {
  const result: Edge[] = [{ type: 'revisitGoals' }, { type: 'review' }];
  if (s.whole === 'explore' && activeIssue(s)) result.push({ type: 'revise', note: '' }, { type: 'defer', note: '' });
  if (s.whole === 'implementation') {
    result.push({ type: 'design', note: '' });
    if (activeUnit(s)) result.push({ type: 'correct', note: '' }, { type: 'defer', note: '' });
  }
  return result;
}
