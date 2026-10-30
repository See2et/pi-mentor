import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { truncateToWidth } from '@earendil-works/pi-tui';
import { DECISIONS, HINTS, INNER, WHOLE, concerns, currentRevision, details, hintPrompt, issueById, location, type State, type UserAction } from './domain.ts';
import { ContractSchema, KINDS, UNIT_PHASES, UNIT_DECISIONS, contractText, unitById, unitDetails, unitRevision, type Contract, type Observation, type Unit } from './units.ts';
import { Value } from 'typebox/value';
import { inspect } from './viewer.ts';
import { selectMenu, confirmMenu } from './navigation.ts';

export interface MenuOwner {
  state(): State;
  observation(): Observation;
  error(): string | undefined;
  token(): string;
  check(token: string): void;
  user(action: UserAction, token: string): void;
  reset(token: string): void;
  view(text: string): void;
  ask(text: string): void;
}
const preview = (text: string) => truncateToWidth(text.replace(/[\r\n\t]/g, ' '), 45);
type Choices = Record<string, string>;
export function primaryActions(s: State): Choices {
  if (!s.enabled) return { resume: 'Mentor を開始・再開' };
  const support = { hint: '今回だけのヒントを依頼', discuss: '現在の位置から対話を始める' };
  if (s.whole === 'implementation') {
    const u = s.activeUnit === null ? undefined : unitById(s, s.activeUnit);
    if (!u) return { unit: '変更単位を作成する', units: '現在の変更単位を選ぶ', ...support };
    return {
      ...(u.phase === 'scope' ? { unit: '単位のスコープを作成・改訂…', ...(unitRevision(u) ? { 'unit-go:implementing': 'この契約で実装を開始する' } : {}) } :
        u.phase === 'implementing' ? { evidence: '証拠・準備完了報告を確認', 'unit-go:examination': '証拠の検討へ移る' } :
        u.phase === 'examination' ? { evidence: '期待と証拠を照合して読む', note: '質問・学習メモを残す（任意）', 'unit-go:judgment': '本人判断へ移る' } :
        { 'unit-judge': 'この単位を判断する', evidence: '契約・証拠・懸念を確認', note: '質問・学習メモを残す（任意）' }),
      ...support,
    };
  }
  if (s.whole === 'goals') return { goal: '全体目標を編集', constraints: '制約を編集', 'go:issues': '論点の洗い出しへ移る', ...support };
  if (s.whole === 'issues') return { add: '論点を追加', select: '現在の論点を選ぶ', ...(s.activeIssue ? { 'inner:hypothesis': '選択した論点の仮説形成へ移る' } : {}), ...support };
  if (s.whole === 'consistency') return { discuss: '全体の整合性を相談する', 'go:summary': 'まとめへ移る', hint: support.hint };
  if (s.whole === 'summary') return { discuss: '決定と未解決事項をまとめる', 'go:implementation': '実装・検証へ移る（まとめ完了は不要）', hint: support.hint };
  const i = s.activeIssue === null ? undefined : issueById(s, s.activeIssue);
  if (!i) return { select: '現在の論点を選ぶ', ...support };
  if (i.inner === 'hypothesis') return { hypothesisMenu: '仮説を作成・改訂…', 'inner:critique': '批判・弁護へ移る', ...support };
  if (i.inner === 'critique') return { concerns: '現在の懸念を読む', response: '弁護・応答を本人記録する', 'inner:judgment': '仮説の判断へ移る', ...support };
  return { judge: '現在の仮説を判断する', 'inner:hypothesis': '仮説形成に戻る', 'go:consistency': '全体整合性へ移る', ...support };
}

export async function mentorMenu(args: string, ctx: ExtensionCommandContext, owner: MenuOwner, initialScreen: 'main' | 'navigation' | 'hypothesisMenu' | 'records' = 'main'): Promise<void> {
  const beforeIdle = owner.token();
  if (!ctx.isIdle()) {
    ctx.ui.notify('Mentor: 現在の応答の終了を待っています。', 'info');
    await ctx.waitForIdle();
    if (beforeIdle.split('/').slice(0, 2).join('/') !== owner.token().split('/').slice(0, 2).join('/')) throw new Error('Session/branch changed while waiting. Open /mentor again.');
  }
  const token = owner.token();
  const s = owner.state();
  const observation = owner.observation();
  const select = async <T extends string>(title: string, choices: Partial<Record<T, string>>): Promise<T | undefined> => {
    const value = await selectMenu(ctx, title, Object.values(choices).filter((v): v is string => typeof v === 'string'));
    owner.check(token);
    return (Object.keys(choices) as T[]).find(k => choices[k] === value);
  };
  const edit = async (title: string, prefill = '') => {
    const value = await ctx.ui.editor(title, prefill); owner.check(token); return value;
  };
  const confirm = async (title: string, text: string) => {
    const yes = await confirmMenu(ctx, title, text); owner.check(token); return yes;
  };
  const read = async (title: string, text: string) => {
    const result = await inspect(ctx, title, text); owner.check(token); return result;
  };
  const exact = async (title: string, text: string) => await read(title, text) && await confirm(title, '直前の閲覧画面に表示した正確な内容で確定します。取消では記録しません。');
  let op = args.trim();
  if (op === 'status') { owner.view(details(s, observation) + (owner.error() ? `\n\n${owner.error()}` : '')); return; }
  if (owner.error()) {
    op ||= await select('Mentor: 保存データを確認してください', { cancel: '閉じる（変更なし）', status: '状態・履歴（最後の有効データ）', reset: '明示的にリセット（この枝に新規状態を保存）' }) ?? '';
    if (op === 'status') owner.view(`${details(s, observation)}\n\n${owner.error()}`);
    else if (op === 'reset' && await confirm('Mentor データのリセット', '現在の枝に空の状態を保存します。過去のセッションエントリは削除しません。続けますか？')) owner.reset(token);
    return;
  }
  let screen = initialScreen;
  let parent: typeof screen | undefined = op ? undefined : screen;
  const back = async () => { if (parent) await mentorMenu('', ctx, owner, parent); };
  while (!op) {
    const main = screen === 'main' ? await select(location(s, observation).map(preview).join('\n'), { cancel: '閉じる（変更なし）', ...primaryActions(s), records: '記録を見る…', navigation: '移動・その他…' }) : screen;
    if (!main || main === 'cancel') return;
    if (main === 'records') {
      screen = 'records';
      const chosen = await select('記録を見る（変更なし）', { back: '戻る', current: '現在の論点／単位の記録', all: '全記録・履歴', proposals: 'AI提案（未決定）' });
      if (!chosen) return;
      if (chosen === 'back') { screen = 'main'; continue; }
      const text = chosen === 'all' ? details(s, observation) : chosen === 'proposals' ? s.proposals.map(p => `p${p.id}: ${p.text}`).join('\n\n') || 'なし' : s.whole === 'implementation' && s.activeUnit !== null ? unitDetails(unitById(s, s.activeUnit), observation) : details(s, observation);
      if (!await read(chosen === 'all' ? '全記録・履歴' : chosen === 'proposals' ? 'AI提案（未決定）' : '現在の記録', text)) return;
      continue;
    }
    if (main === 'navigation') {
      const chosen = await select('移動・その他（移動は本人操作だけ）', {
        back: '戻る', phase: '全体の移動先を選ぶ…', ...(s.whole === 'implementation' && s.activeUnit !== null ? { unitphase: '単位内の移動先を選ぶ…' } : {}),
        select: '現在の論点を選ぶ', units: '現在の変更単位を選ぶ', unitNew: '新しい変更単位を作成',
        goal: '全体目標を編集', constraints: '制約を編集', add: '論点を追加', issue: '現在の論点を編集',
        ...(s.enabled ? { pause: 'Mentor を一時停止（通常チャットへ）' } : { resume: 'Mentor を再開' }),
      });
      if (!chosen) return;
      if (chosen === 'back') { screen = 'main'; continue; }
      parent = 'navigation'; op = chosen;
    } else if (main === 'hypothesisMenu') {
      const chosen = await select('仮説を作成・改訂', { back: '戻る', hypothesis: '本人の仮説を作成・改訂', draft: 'AI下書きを確認・編集' });
      if (!chosen) return;
      if (chosen === 'back') { screen = 'main'; continue; }
      parent = 'hypothesisMenu'; op = chosen;
    } else { parent = 'main'; op = main; }
  }
  if (op === 'resume' || op === 'pause') { owner.user({ type: op }, token); return; }
  if (!s.enabled) throw new Error('Mentor は一時停止中です。/mentor resume で再開してください。');
  if (op.startsWith('go:')) { owner.user({ type: 'phase', whole: op.slice(3) as State['whole'] }, token); return; }
  if (op.startsWith('inner:')) { owner.user({ type: 'phase', whole: 'explore', inner: op.slice(6) as keyof typeof INNER }, token); return; }
  if (op === 'goal' || op === 'constraints') {
    const value = await edit(op === 'goal' ? '全体目標（保存すると本人の記録になります）' : '制約', s[op]);
    if (value !== undefined) owner.user({ type: op, text: value }, token); return;
  }
  if (op === 'add') {
    const value = await edit('論点を追加（追加だけでは現在の論点やフェーズは変わりません）');
    if (value !== undefined) owner.user({ type: 'issue', text: value }, token); return;
  }
  if (op === 'select' || op === 'units') {
    const choices = op === 'select' ? s.issues.map(i => [`id:${i.id}`, `#${i.id} ${preview(i.text)}`]) : s.units.map(u => [`id:${u.id}`, `U${u.id} ${preview(unitRevision(u)?.contract.title ?? u.revisions.at(-1)?.contract.title ?? '未確認')}`]);
    if (!choices.length) throw new Error(op === 'select' ? 'まず論点を追加してください。' : 'まず変更単位を作成してください。');
    const chosen = await select(op === 'select' ? '現在の論点を選択（フェーズは変わりません）' : '現在の変更単位を選択（自動開始しません）', { back: '戻る（変更なし）', ...Object.fromEntries(choices) });
    if (chosen === 'back') return back();
    if (chosen) owner.user(op === 'select' ? { type: 'select', issueId: Number(chosen.slice(3)) } : { type: 'selectUnit', unitId: Number(chosen.slice(3)) }, token); return;
  }
  if (op === 'phase') {
    for (;;) {
      const chosen = await select('全体フェーズの移動先', { back: '戻る（変更なし）', ...WHOLE });
      if (!chosen) return;
      if (chosen === 'back') return back();
      if (chosen !== 'explore') { owner.user({ type: 'phase', whole: chosen }, token); return; }
      if (s.activeIssue === null) throw new Error('「現在の論点を選ぶ」で論点を選択してください。');
      const inner = await select('論点内フェーズの移動先', { back: '戻る（変更なし）', ...INNER });
      if (!inner) return;
      if (inner === 'back') continue;
      owner.user({ type: 'phase', whole: chosen, inner }, token); return;
    }
  }
  if (op === 'hint') {
    const kind = await select('今回の応答だけのヒント（どのフェーズでも選べます）', { back: '戻る（変更なし）', ...HINTS });
    if (kind === 'back') return back();
    if (kind) { owner.check(token); owner.ask(hintPrompt(s, kind)); } return;
  }
  if (op === 'discuss') {
    owner.check(token);
    owner.ask(`[Mentor: current-phase discussion request]\n${location(s, observation).join('\n')}\nHelp me work at this location. Do not change phase, select an issue/unit, or make a judgment for me.`); return;
  }
  if (op === 'unit' || op === 'unitNew' || op === 'unit-draft') {
    const u = op === 'unitNew' || s.activeUnit === null ? undefined : unitById(s, s.activeUnit);
    if (op === 'unit-draft' && !u) throw new Error('先に変更単位を選択してください。');
    let kind: keyof typeof KINDS;
    for (;;) {
      const choice = u && op === 'unit' ? await select('単位のスコープ', { back: '戻る（変更なし）', edit: '契約を作成・改訂する', draft: 'AI下書きの正確な内容を確認する' }) : op === 'unit-draft' ? 'draft' : 'edit';
      if (!choice) return;
      if (choice === 'back') return back();
      if (choice === 'draft' && u) {
        const drafts = u.revisions.filter(r => !r.confirmed);
        const chosen = await select<string>('未確認の契約下書き', { back: '戻る（変更なし）', ...Object.fromEntries(drafts.map(r => [`r:${r.revision}`, `契約 v${r.revision} ${preview(r.contract.title)}`])) });
        if (!chosen) return;
        if (chosen === 'back') { if (op === 'unit') continue; return back(); }
        const revision = Number(chosen.slice(2));
        if (await exact(`U${u.id} / 契約 v${revision} の正確な内容を確認（開始・受入ではありません）`, contractText(u, revision))) owner.user({ type: 'confirmUnit', unitId: u.id, revision }, token);
        return;
      }
      const chosenKind = await select('変更単位の種類（実験の受入は設計採用ではありません）', { back: '戻る（変更なし）', ...KINDS });
      if (!chosenKind) return;
      if (chosenKind === 'back') { if (u && op === 'unit') continue; return back(); }
      kind = chosenKind; break;
    }
    const prior = u && unitRevision(u)?.contract;
    const title = await edit('単位の題名', prior?.title); if (title === undefined) return;
    const purpose = await edit('目的', prior?.purpose); if (purpose === undefined) return;
    const refs = await edit('参照設計（1行1件。論点／仮説の版、または明示的な仕様参照）', prior?.designRefs.join('\n')); if (refs === undefined) return;
    const scope = await edit('スコープ（今回だけの実装・実験範囲）', prior?.scope); if (scope === undefined) return;
    const expects = await edit('具体的な期待（1行1件 E1: 内容。改訂時も同じ期待のIDを保持）', prior?.expectations.map(e => `${e.id}: ${e.text}`).join('\n') ?? 'E1: '); if (expects === undefined) return;
    const nonGoals = await edit('非目標（やらないこと。ない場合も「なし」と明記）', prior?.nonGoals); if (nonGoals === undefined) return;
    const verificationPlan = await edit('検証計画（期待とは別。方法・実対象／代替・限界）', prior?.verificationPlan); if (verificationPlan === undefined) return;
    const contract: Contract = { kind, title, purpose, designRefs: refs.split('\n').filter(x => x.trim()), scope, expectations: expects.split('\n').filter(x => x.trim()).map(line => {
      const match = /^([A-Za-z][A-Za-z0-9_-]{0,39}):\s*(.+)$/.exec(line);
      if (!match) throw new Error('期待は E1: 具体的な振る舞い の形式で記入してください。');
      return { id: match[1], text: match[2] };
    }), nonGoals, verificationPlan };
    if (!Value.Check(ContractSchema, contract)) throw new Error('契約の必須項目・期待の形式を確認してください。');
    const revision = (u?.revisions.length ?? 0) + 1;
    const review = { id: u?.id ?? s.units.length + 1, revisions: [{ revision, contract, author: 'human', confirmed: false }] } as Unit;
    if (await exact(`U${review.id} / 契約 v${revision} を本人確認（開始・受入は別操作）`, contractText(review, revision))) owner.user({ type: 'unitContract', unitId: u?.id, contract }, token);
    return;
  }
  if (['unitphase', 'evidence', 'note', 'unit-judge'].includes(op) || op.startsWith('unit-go:')) {
    if (s.activeUnit === null) throw new Error('先に変更単位を選んでください。');
    const u = unitById(s, s.activeUnit);
    if (op === 'unitphase' || op.startsWith('unit-go:')) {
      const phase = op.startsWith('unit-go:') ? op.slice(8) as Unit['phase'] : await select('単位内の移動先（戻る操作も本人だけ）', { back: '戻る（変更なし）', ...UNIT_PHASES });
      if (!phase) return;
      if (phase === 'back') return back();
      if (phase === 'implementing' && !await exact(`U${u.id} / 契約 v${u.currentRevision} で実装開始`, contractText(u))) return;
      owner.user({ type: 'unitPhase', unitId: u.id, phase }, token); return;
    }
    if (op === 'evidence') { await read(`U${u.id}: 契約・期待・証拠・限界`, unitDetails(u, observation)); return; }
    if (op === 'note') {
      const text = await edit('自分の質問・学習メモ（任意。AIの理解度判定には使いません）');
      if (text !== undefined) owner.user({ type: 'unitNote', unitId: u.id, text }, token); return;
    }
    if (!await read(`U${u.id} / 契約 v${u.currentRevision}: 判断対象の全記録`, unitDetails(u, observation))) return;
    const decision = await select('本人判断（AI合格判定なし。フェーズは自動で進みません）', { back: '戻る（変更なし）', ...(unitRevision(u) ? UNIT_DECISIONS : { design: UNIT_DECISIONS.design, defer: UNIT_DECISIONS.defer }) });
    if (!decision) return;
    if (decision === 'back') return back();
    const note = await edit(`${UNIT_DECISIONS[decision]} — 理由・留保・既知／未知の懸念（空欄可）`); if (note === undefined) return;
    const final = `${unitDetails(u, observation)}\n\n本人の選択: ${UNIT_DECISIONS[decision]}\n理由・留保: ${note}\n${decision === 'design' ? '全体フェーズを「論点の洗い出し」に戻します。' : 'この判断だけを記録します。次の単位・フェーズへは進みません。'}`;
    if (await exact(`U${u.id} / 契約 v${u.currentRevision} の本人判断を確定`, final)) owner.user({ type: 'unitJudge', unitId: u.id, decision, note }, token);
    return;
  }
  if (!['issue', 'hypothesis', 'draft', 'response', 'judge', 'concerns'].includes(op)) throw new Error('Unknown /mentor action. Use /mentor for contextual menus or the existing shortcuts; unit, units, unitNew, unit-draft, unitphase, evidence, note, unit-judge are also available.');
  if (s.activeIssue === null) throw new Error('まず現在の論点を選んでください。');
  const issue = issueById(s, s.activeIssue);
  if (op === 'concerns') {
    await read(`論点 #${issue.id} / r${issue.currentRevision}: 現在の懸念`, concerns(issue).map(c => `c${c.id} [${c.category}] ${c.text}\n根拠・条件: ${c.evidence}`).join('\n\n') || '未撤回の懸念の記録なし（正しさの保証ではありません）'); return;
  }
  if (op === 'issue' || op === 'hypothesis') {
    const value = await edit(op === 'issue' ? `論点 #${issue.id} を編集` : `仮説 #${issue.id} — 保存で新しい本人確認済みリビジョンを作成`, op === 'issue' ? issue.text : currentRevision(issue)?.text);
    if (value !== undefined) owner.user({ type: op === 'issue' ? 'issue' : 'hypothesis', issueId: issue.id, text: value }, token);
  } else if (op === 'draft') {
    const drafts = issue.revisions.filter(r => !r.confirmed);
    if (!drafts.length) throw new Error('この論点に未確認のAI下書きはありません。仮説を自分で作成できます。');
    for (;;) {
      const picked = await select<string>('AI下書き（まだ本人の仮説ではありません）', { back: '戻る（変更なし）', ...Object.fromEntries(drafts.map(r => [`r:${r.revision}`, `r${r.revision} ${preview(r.text)}`])) });
      if (!picked) return;
      if (picked === 'back') return back();
      const draft = drafts.find(r => r.revision === Number(picked.slice(2)))!;
      if (!await read(`仮説 r${draft.revision} の正確な内容（未確定）`, draft.text)) return;
      const choice = await select(`仮説 r${draft.revision}`, { back: '戻る（変更なし）', confirm: 'この正確な内容を本人の現在仮説として確認', edit: '内容を編集して新しい本人仮説を保存' });
      if (choice === 'back') continue;
      if (choice === 'confirm' && await confirm(`仮説 r${draft.revision} を本人確認（採用判断ではありません）`, '直前に閲覧した正確な内容を現在仮説にします。')) owner.user({ type: 'confirmDraft', issueId: issue.id, revision: draft.revision }, token);
      else if (choice === 'edit') {
        const text = await edit('本人仮説として改訂', draft.text);
        if (text !== undefined) owner.user({ type: 'hypothesis', issueId: issue.id, text }, token);
      }
      return;
    }
  } else if (op === 'response') {
    const options = { back: '戻る（変更なし）', general: '現在の仮説への一般的な応答', ...Object.fromEntries(issue.critiques.filter(c => c.revision === issue.currentRevision).map(c => [`c:${c.id}`, `c${c.id} [${c.category}] ${preview(c.text)}`])) };
    const picked = await select<string>('応答先（弁護・同意・質問など自由に記録）', options);
    if (!picked) return;
    if (picked === 'back') return back();
    const text = await edit('本人の応答（判断やフェーズは変わりません）');
    if (text !== undefined) owner.user({ type: 'response', issueId: issue.id, text, critiqueId: picked === 'general' ? undefined : Number(picked.slice(2)) }, token);
  } else if (op === 'judge') {
    const r = currentRevision(issue);
    const open = concerns(issue);
    const evidence = `#${issue.id}: ${issue.text}\n\n現在仮説 r${r?.revision ?? '—'}: ${r?.text ?? '（仮説なし。保留・修正するを選べます）'}\n\n未撤回の懸念:\n${open.length ? open.map(c => `c${c.id} [${c.category}] ${c.text}\n根拠・条件: ${c.evidence}`).join('\n') : '記録なし（正しさの保証ではありません）'}`;
    if (!await read(`論点 #${issue.id} / r${r?.revision ?? '—'}: 判断対象`, evidence)) return;
    const decision = await select('本人の判断（AIの合格判定は不要）', { back: '戻る（変更なし）', ...(r ? DECISIONS : { revise: DECISIONS.revise, defer: DECISIONS.defer }) });
    if (!decision) return;
    if (decision === 'back') return back();
    const note = await edit(`${DECISIONS[decision]} — 理由・留保（空欄可。Esc は全体を取消）`);
    if (note === undefined) return;
    if (await exact(`r${r?.revision ?? '—'}: ${DECISIONS[decision]} を記録（フェーズは変わりません）`, `${evidence}\n\n本人判断: ${DECISIONS[decision]}\n${note}`)) owner.user({ type: 'judge', issueId: issue.id, decision, note }, token);
  }
}
