import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { DECISIONS, HINTS, INNER, WHOLE, concerns, currentRevision, details, hintPrompt, issueById, type State, type UserAction } from './domain.ts';

export interface MenuOwner {
  state(): State;
  error(): string | undefined;
  token(): string;
  check(token: string): void;
  user(action: UserAction, token: string): void;
  reset(token: string): void;
  view(text: string): void;
  ask(text: string): void;
}
const preview = (text: string) => text.replace(/[\r\n\t]/g, ' ').slice(0, 70);

export async function mentorMenu(args: string, ctx: ExtensionCommandContext, owner: MenuOwner): Promise<void> {
  // Session/tree changes during idle waiting must not bind an old command to a new session.
  const beforeIdle = owner.token();
  if (!ctx.isIdle()) {
    ctx.ui.notify('Mentor: 現在の応答の終了を待っています。', 'info');
    await ctx.waitForIdle();
    // Records may advance while waiting; only session/branch identity must remain stable.
    if (beforeIdle.split('/').slice(0, -1).join('/') !== owner.token().split('/').slice(0, -1).join('/')) throw new Error('Session/branch changed while waiting. Open /mentor again.');
  }
  const token = owner.token();
  const s = owner.state();
  const select = async <T extends string>(title: string, choices: Partial<Record<T, string>>): Promise<T | undefined> => {
    const value = await ctx.ui.select(title, Object.values(choices).filter((v): v is string => typeof v === 'string'));
    owner.check(token);
    return (Object.keys(choices) as T[]).find(k => choices[k] === value);
  };
  const edit = async (title: string, prefill = '') => {
    const value = await ctx.ui.editor(title, prefill);
    owner.check(token);
    return value;
  };
  const confirm = async (title: string, text: string) => {
    const yes = await ctx.ui.confirm(title, text);
    owner.check(token);
    return yes;
  };
  let op = args.trim();
  if (op === 'status') { owner.view(details(s) + (owner.error() ? `\n\n${owner.error()}` : '')); return; }
  if (owner.error()) {
    op ||= await select('Mentor: 保存データを確認してください', { status: '状態・履歴（最後の有効データ）', reset: '明示的にリセット（この枝に新規状態を保存）' }) ?? '';
    if (op === 'status') owner.view(`${details(s)}\n\n${owner.error()}`);
    else if (op === 'reset' && await confirm('Mentor データのリセット', '現在の枝に空の状態を保存します。過去のセッションエントリは削除しません。続けますか？')) owner.reset(token);
    return;
  }
  if (!op) {
    op = await select('Mentor — 操作を選択（Esc で変更なし）', s.enabled ? {
      status: '状態・履歴を見る', goal: '全体目標を編集', constraints: '制約を編集', add: '論点を追加',
      select: '現在の論点を選ぶ', issue: '現在の論点を編集', phase: '移動先のフェーズを選ぶ（戻る操作もここ）',
      hypothesis: '仮説を作成・改訂', draft: 'AI下書きを確認する', response: '弁護・応答を本人記録する',
      judge: '現在の仮説を判断する', hint: '今回だけのヒントを依頼', discuss: '現在の位置から対話を始める', pause: 'Mentor を一時停止（通常チャットへ）',
    } : { resume: 'Mentor を開始・再開', status: '状態・履歴を見る' }) ?? '';
  }
  if (!op) return;
  if (op === 'status') { owner.view(details(s)); return; }
  if (op === 'resume' || op === 'pause') { owner.user({ type: op }, token); return; }
  if (!s.enabled) throw new Error('Mentor は一時停止中です。/mentor resume で再開してください。');
  if (op === 'goal' || op === 'constraints') {
    const value = await edit(op === 'goal' ? '全体目標（保存すると本人の記録になります）' : '制約', s[op]);
    if (value !== undefined) owner.user({ type: op, text: value }, token);
    return;
  }
  if (op === 'add') {
    const value = await edit('論点を追加（追加だけでは現在の論点やフェーズは変わりません）');
    if (value !== undefined) owner.user({ type: 'issue', text: value }, token);
    return;
  }
  if (op === 'select') {
    if (!s.issues.length) throw new Error('まず論点を追加してください。');
    const choices = Object.fromEntries(s.issues.map(i => [String(i.id), `#${i.id} ${preview(i.text)}`]));
    const chosen = await select('現在の論点を選択（フェーズは変わりません）', choices);
    if (chosen) owner.user({ type: 'select', issueId: Number(chosen) }, token);
    return;
  }
  if (op === 'phase') {
    const chosen = await select('全体フェーズの移動先', WHOLE);
    if (!chosen) return;
    if (chosen !== 'explore') { owner.user({ type: 'phase', whole: chosen }, token); return; }
    if (s.activeIssue === null) throw new Error('「現在の論点を選ぶ」で論点を選択してください。');
    const inner = await select('論点内フェーズの移動先', INNER);
    if (inner) owner.user({ type: 'phase', whole: chosen, inner }, token);
    return;
  }
  if (op === 'hint') {
    const kind = await select('今回の応答だけのヒント（どのフェーズでも選べます）', HINTS);
    if (kind) { owner.check(token); owner.ask(hintPrompt(s, kind)); }
    return;
  }
  if (op === 'discuss') {
    owner.check(token);
    owner.ask(`[Mentor: current-phase discussion request]\n${detailsForDiscussion(s)}\nAsk a focused question or help me work at this location. Do not change phase, select an issue, or make a judgment for me.`);
    return;
  }
  if (!['issue', 'hypothesis', 'draft', 'response', 'judge'].includes(op)) throw new Error('Unknown /mentor action. Use /mentor for the menu, or status, resume, pause, goal, constraints, add, select, issue, phase, hypothesis, draft, response, judge, hint, discuss.');
  if (s.activeIssue === null) throw new Error('まず現在の論点を選んでください。');
  const issue = issueById(s, s.activeIssue);
  if (op === 'issue' || op === 'hypothesis') {
    const value = await edit(op === 'issue' ? `論点 #${issue.id} を編集` : `仮説 #${issue.id} — 保存で新しい本人確認済みリビジョンを作成`, op === 'issue' ? issue.text : currentRevision(issue)?.text);
    if (value !== undefined) owner.user({ type: op === 'issue' ? 'issue' : 'hypothesis', issueId: issue.id, text: value }, token);
  } else if (op === 'draft') {
    const drafts = issue.revisions.filter(r => !r.confirmed);
    if (!drafts.length) throw new Error('この論点に未確認のAI下書きはありません。チャットで整理を依頼するか、仮説を自分で作成できます。');
    const picked = await select('AI下書き（まだ本人の仮説ではありません）', Object.fromEntries(drafts.map(r => [String(r.revision), `r${r.revision} ${preview(r.text)}`])));
    if (!picked) return;
    const draft = drafts.find(r => r.revision === Number(picked))!;
    const choice = await select(`r${draft.revision}: ${draft.text}`, { confirm: 'この正確な内容を本人の現在仮説として確認', edit: '内容を編集して新しい本人仮説を保存' });
    if (choice === 'confirm' && await confirm('AI下書きを本人仮説として確認（採用判断ではありません）', draft.text)) owner.user({ type: 'confirmDraft', issueId: issue.id, revision: draft.revision }, token);
    else if (choice === 'edit') {
      const text = await edit('本人仮説として改訂', draft.text);
      if (text !== undefined) owner.user({ type: 'hypothesis', issueId: issue.id, text }, token);
    }
  } else if (op === 'response') {
    const options = { general: '現在の仮説への一般的な応答', ...Object.fromEntries(issue.critiques.filter(c => c.revision === issue.currentRevision).map(c => [String(c.id), `c${c.id} [${c.category}] ${preview(c.text)}`])) };
    const picked = await select('応答先（弁護・同意・質問など自由に記録）', options);
    if (!picked) return;
    const text = await edit('本人の応答（判断やフェーズは変わりません）');
    if (text !== undefined) owner.user({ type: 'response', issueId: issue.id, text, critiqueId: picked === 'general' ? undefined : Number(picked) }, token);
  } else if (op === 'judge') {
    const r = currentRevision(issue);
    const open = concerns(issue);
    const evidence = `#${issue.id}: ${issue.text}\n\n現在仮説 r${r?.revision ?? '—'}: ${r?.text ?? '（仮説なし。保留・修正するを選べます）'}\n\n未撤回の懸念:\n${open.length ? open.map(c => `c${c.id} [${c.category}] ${c.text}\n根拠・条件: ${c.evidence}`).join('\n') : '記録なし（正しさの保証ではありません）'}`;
    const decision = await select(evidence + '\n\n本人の判断（AIの合格判定は不要）', r ? DECISIONS : { revise: DECISIONS.revise, defer: DECISIONS.defer });
    if (!decision) return;
    const note = await edit(`${DECISIONS[decision]} — 理由・留保（空欄可。Esc は全体を取消）`);
    if (note === undefined) return;
    if (await confirm(`${DECISIONS[decision]} を記録しますか？ フェーズは変わりません。`, `${evidence}\n\n本人判断: ${DECISIONS[decision]}\n${note}`)) owner.user({ type: 'judge', issueId: issue.id, decision, note }, token);
  }
}
function detailsForDiscussion(s: State): string {
  const issue = s.activeIssue === null ? undefined : issueById(s, s.activeIssue);
  return `Whole phase: ${WHOLE[s.whole]}; inner phase: ${issue ? INNER[issue.inner] : 'none'}; active issue: ${issue ? `#${issue.id} ${issue.text}` : 'none'}.`;
}
