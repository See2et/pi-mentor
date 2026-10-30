import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import mentorExtension from '../index.ts';
import { currentJudgment, location } from '../src/domain.ts';
import { unitJudgment, evidenceFreshness } from '../src/units.ts';

type Handler = (...args: any[]) => any;
function harness(manager = SessionManager.inMemory(), cwd = process.cwd()) {
  const events = new Map<string, Handler>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const h = {
    manager, events, tools, commands,
    choices: [] as (string | undefined)[], edits: [] as (string | undefined)[], confirmations: [] as boolean[],
    notices: [] as string[], requests: [] as string[],
    menus: [] as { title: string; options: string[] }[], inspections: [] as string[][],
    cardResults: [] as string[],
    inspectResults: [] as boolean[], inspector: undefined as (() => Promise<any>) | undefined,
    widget: undefined as Handler | undefined,
    editor: undefined as (() => Promise<string | undefined>) | undefined,
    async emit(name: string, event: object = {}) { return events.get(name)!({ type: name, ...event }, h.ctx()); },
    ctx(): ExtensionCommandContext {
      return {
        sessionManager: h.manager, cwd, mode: 'tui', hasUI: true, isIdle: () => true,
        ui: {
          select: async (title: string, options: string[]) => { h.menus.push({ title, options }); return h.choices.shift(); },
          custom: async (factory: Handler) => {
            const component = factory({ terminal: { rows: 28 }, requestRender() {} }, { fg: (_t: string, x: string) => x }, {}, () => {});
            h.inspections.push(component.render(36));
            return h.cardResults.length ? h.cardResults.shift() : h.inspector ? h.inspector() : h.inspectResults.shift() ?? true;
          },
          editor: () => h.editor ? h.editor() : Promise.resolve(h.edits.shift()),
          confirm: async () => h.confirmations.shift() ?? false,
          notify: (message: string) => h.notices.push(message),
          setWidget: (_key: string, factory: Handler) => { h.widget = factory; },
        },
      } as unknown as ExtensionCommandContext;
    },
    async command(args = '') { await commands.get('mentor').handler(args, h.ctx()); },
    async status() { return (await tools.get('mentor_status').execute('s', {}, undefined, undefined, h.ctx())).details; },
    async record(action: object, expectedSnapshot?: string) {
      return tools.get('mentor_record').execute('r', { expectedSnapshot: expectedSnapshot ?? (await h.status()).snapshot, action }, undefined, undefined, h.ctx());
    },
    async next(proposal: object, expectedSnapshot?: string) {
      assert.ok(tools.get('mentor_next'), 'AI can prepare one next-action card without advancing');
      return tools.get('mentor_next').execute('n', { expectedSnapshot: expectedSnapshot ?? (await h.status()).snapshot, proposal }, undefined, undefined, h.ctx());
    },
    render(width: number): string[] { return h.widget!({}, { fg: (_token: string, text: string) => text }).render(width); },
  };
  const api = {
    on: (name: string, handler: Handler) => events.set(name, handler),
    registerCommand: (name: string, command: unknown) => commands.set(name, command),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerMessageRenderer() {},
    appendEntry: (kind: string, data: unknown) => h.manager.appendCustomEntry(kind, data),
    sendMessage: (message: any) => h.manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details),
    sendUserMessage: (text: string) => h.requests.push(text),
  } as unknown as ExtensionAPI;
  mentorExtension(api);
  return h;
}
async function prepared() {
  const h = harness();
  await h.emit('session_start');
  await h.command('resume');
  h.edits.push('安全な入力を設計する'); await h.command('goal');
  h.edits.push('既存APIを維持する'); await h.command('constraints');
  h.edits.push('入力検証'); await h.command('add');
  h.choices.push('#1 入力検証'); await h.command('select');
  h.edits.push('境界で検証する'); await h.command('hypothesis');
  assert.equal((await h.status()).record.issues[0].currentRevision, 1);
  return h;
}

test('cancelled menu, editor, nested phase and final judgment confirmation have no effects', async () => {
  const h = await prepared();
  const before = await h.status();
  const count = h.manager.getEntries().length;
  await h.command();
  await h.command('goal');
  h.choices.push('論点の検討', undefined); await h.command('phase');
  h.choices.push('暫定採用'); h.edits.push('This should be cancelled'); h.confirmations.push(false);
  await h.command('judge');
  assert.deepEqual((await h.status()).record, before.record);
  assert.equal(h.manager.getEntries().length, count);
  assert.equal(h.requests.length, 0);
});

test('menu and tools support grounded critique, human defense, AI retraction, exact human judgment and revision history', async () => {
  const h = await prepared();
  h.choices.push('論点の検討', '批判・弁護'); await h.command('phase');
  let result = await h.record({ type: 'critique', issueId: 1, revision: 1, category: 'security', text: '長さ制限がない', evidence: '無制限の文字列がパーサに届く場合', status: 'open' });
  assert.equal(result.isError, undefined);
  h.choices.push('c1 [security] 長さ制限がない'); h.edits.push('上流に上限がある。handler.ts:20'); await h.command('response');
  result = await h.record({ type: 'critique', issueId: 1, revision: 1, category: 'security', text: '上流制限の確認により撤回', evidence: 'handler.ts:20 で上限が保証される条件', status: 'withdrawn', replaces: 1 });
  assert.equal(result.isError, undefined);
  h.choices.push('暫定採用'); h.edits.push('上流制限を維持する'); h.confirmations.push(true); await h.command('judge');
  let state = (await h.status()).record;
  assert.equal(state.whole, 'explore');
  assert.equal(state.issues[0].inner, 'critique'); // judgment is not a transition
  assert.equal(state.issues[0].judgments[0].author, 'human');
  assert.equal(state.issues[0].responses[0].author, 'human');
  assert.equal(state.issues[0].critiques.length, 2);
  await h.record({ type: 'draft', issueId: 1, text: '上流制限も契約にする' });
  assert.equal((await h.status()).record.issues[0].currentRevision, 1);
  h.choices.push('r2 上流制限も契約にする', 'この正確な内容を本人の現在仮説として確認'); h.confirmations.push(true); await h.command('draft');
  state = (await h.status()).record;
  assert.equal(state.issues[0].currentRevision, 2);
  assert.equal(state.issues[0].judgments[0].revision, 1);
  assert.equal(currentJudgment(state.issues[0]), undefined);
  assert.equal(h.requests.length, 0);
});

test('tools reject stale concurrent proposals; open dialogs cannot commit over model updates or session replacement', async () => {
  const h = await prepared();
  const old = (await h.status()).snapshot;
  await h.record({ type: 'proposal', text: '整理を提案' }, old);
  const stale = await h.record({ type: 'proposal', text: '古い並行呼出し' }, old);
  assert.equal(stale.isError, true);
  assert.equal((await h.status()).record.proposals.length, 1);
  let resolve!: (text: string) => void;
  h.editor = () => new Promise(done => { resolve = done; });
  const open = h.command('goal');
  await h.record({ type: 'proposal', text: '開いたメニューの後の変更' });
  resolve('stale text'); await open;
  assert.equal((await h.status()).record.goal, '安全な入力を設計する');
  assert.match(h.notices.at(-1)!, /state changed/);
  const oldDialog = h.command('goal');
  const oldManager = h.manager;
  h.manager = SessionManager.inMemory();
  await h.emit('session_start', { reason: 'new' });
  resolve('wrong session'); await oldDialog;
  assert.equal((await h.status()).record.goal, '');
  assert.equal(oldManager.getBranch().at(-1)?.type, 'custom');
  assert.equal(h.manager.getEntries().length, 0);
});

test('hints queue one native user request without state change; paused normal chat has no injected guidance', async () => {
  const h = await prepared();
  const before = await h.status();
  h.choices.push('部分案'); await h.command('hint');
  assert.deepEqual((await h.status()).record, before.record);
  assert.equal(h.requests.length, 1);
  assert.match(h.requests[0], /this response only/);
  await h.command('pause');
  const paused = await h.status();
  assert.equal((await h.record({ type: 'proposal', text: '禁止' })).isError, true);
  const context = await h.emit('context', { messages: [] });
  assert.deepEqual(context.messages, []);
  await h.command('hint');
  assert.deepEqual((await h.status()).record, paused.record);
  assert.equal(h.requests.length, 1);
  assert.ok(h.render(32).join('\n').includes('一時停止'));
  await h.command('resume');
  assert.ok((await h.emit('context', { messages: [] })).messages[0].content.includes('CURRENT LOCATION'));
});

test('active branch restoration excludes abandoned data and keeps widget and context aligned after compaction/reload', async () => {
  const h = await prepared();
  const base = h.manager.getLeafId()!;
  h.choices.push('まとめ'); await h.command('phase');
  const future = h.manager.getLeafId()!;
  h.manager.branch(base);
  await h.emit('session_tree');
  assert.ok(h.manager.getEntries().some(e => e.id === future));
  assert.equal((await h.status()).record.whole, 'goals');
  await h.emit('session_compact');
  await h.emit('session_start', { reason: 'reload' });
  const status = await h.status();
  const context = (await h.emit('context', { messages: [{ role: 'custom', customType: 'mentor-display', content: 'old view' }] })).messages;
  assert.equal(context.length, 1);
  for (const line of location(status.record)) assert.ok(context[0].content.includes(line));
  assert.ok(h.render(100).join('\n').includes('目標と制約を整理する'));
  for (const width of [16, 32, 80, 120]) {
    for (const line of h.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
    assert.ok(!h.render(width).join('\n').includes('r1'), 'normal widget does not expose internal revision management');
  }
});

test('malformed persistence is read-only until an explicit confirmed reset', async () => {
  const h = await prepared();
  h.manager.appendCustomEntry('mentor-state', { schema: 99 });
  await h.emit('session_start', { reason: 'reload' });
  assert.match((await h.status()).error, /invalid or unsupported/);
  const count = h.manager.getEntries().length;
  await h.command('resume');
  await h.record({ type: 'proposal', text: 'must fail' });
  assert.equal(h.manager.getEntries().length, count);
  h.confirmations.push(false); await h.command('reset');
  assert.equal(h.manager.getEntries().length, count);
  h.confirmations.push(true); await h.command('reset');
  assert.equal((await h.status()).error, undefined);
  assert.equal((await h.status()).record.enabled, false);
});

test('Pi session entries survive disk reopening once Pi has a real conversation; active branch is restored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-mentor-test-'));
  try {
    const manager = SessionManager.create(process.cwd(), dir);
    // This is a session fixture, not inference. Pi does not flush setup-only sessions.
    manager.appendMessage({ role: 'user', content: 'Session fixture', timestamp: Date.now() });
    const h = harness(manager);
    await h.emit('session_start'); await h.command('resume');
    h.edits.push('Persisted goal'); await h.command('goal');
    const base = manager.getLeafId()!;
    h.choices.push('まとめ'); await h.command('phase');
    manager.branch(base);
    manager.appendCustomEntry('branch-marker', {});
    h.manager = SessionManager.open(manager.getSessionFile()!);
    await h.emit('session_start', { reason: 'resume' });
    const state = (await h.status()).record;
    assert.equal(state.goal, 'Persisted goal');
    assert.equal(state.whole, 'goals');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const unitContract = { kind: 'feature', title: '入力境界', purpose: '入力を守る', designRefs: ['仕様 input-v1'], scope: '入力ハンドラ', expectations: [{ id: 'E1', text: '過大入力を拒否' }], nonGoals: 'UI', verificationPlan: '実入力を送る' };
async function implementation(h: ReturnType<typeof harness>) {
  await h.emit('session_start'); await h.command('resume');
  h.choices.push('実装・検証'); await h.command('phase');
  await h.record({ type: 'unitDraft', contract: unitContract });
  h.choices.push('U1 入力境界'); await h.command('units');
  h.choices.push('契約 v1 入力境界'); h.confirmations.push(true); await h.command('unit-draft');
  h.confirmations.push(true); await h.command('unit-go:implementing');
}

test('native menu boundary supports human unit creation/exact confirmation, evidence, optional notes and judgment without advancing next unit', async () => {
  const h = harness();
  await h.emit('session_start'); await h.command('resume');
  h.choices.push('実装・検証'); await h.command('phase');
  h.choices.push('機能実装'); h.edits.push('入力境界', '入力を守る', '仕様 input-v1', '入力ハンドラ', 'E1: 過大入力を拒否', 'UI', '実入力を送る'); h.confirmations.push(true);
  await h.command('unitNew');
  let status = await h.status();
  assert.deepEqual(status.record.units[0].revisions[0].contract, unitContract);
  assert.equal(status.record.activeUnit, null);
  h.choices.push('U1 入力境界'); await h.command('units');
  h.confirmations.push(false); await h.command('unit-go:implementing');
  assert.equal((await h.status()).record.units[0].phase, 'scope');
  h.confirmations.push(true); await h.command('unit-go:implementing');
  status = await h.status();
  assert.equal(status.record.units[0].phase, 'implementing');
  const result = await h.record({ type: 'unitEvidence', unitId: 1, revision: 1, sourceHash: status.sourceObservation.source.hash, entries: [{ expectationId: 'E1', observation: '過大入力の拒否を観測', references: ['node check-input.ts; exit 0; response 400'], method: 'real', limitations: '本番サービス未確認' }], concerns: '本番条件は未知' });
  assert.equal(result.isError, undefined);
  await h.command('unit-go:examination');
  h.edits.push('境界値を自分でも確認する'); await h.command('note');
  await h.command('evidence');
  await h.command('unit-go:judgment');
  h.choices.push('このスコープを受け入れる'); h.edits.push('本番は未確認のまま受け入れる'); h.confirmations.push(true); await h.command('unit-judge');
  status = await h.status();
  assert.equal(status.record.units[0].judgments[0].decision, 'accept');
  assert.equal(status.record.units[0].phase, 'judgment');
  assert.equal(status.record.activeUnit, 1);
  assert.equal(status.record.units[0].notes[0].author, 'human');
  assert.equal(h.requests.length, 0);
  const selection = h.menus.find(m => m.options.includes('U1 入力境界'))!;
  assert.equal(selection.options[0], '戻る（変更なし）');
  await h.record({ type: 'unitDraft', unitId: 1, contract: { ...unitContract, scope: '改訂の提案' } });
  const beforeDraft = (await h.status()).record;
  h.choices.push('契約 v2 入力境界'); h.confirmations.push(false); await h.command('unit-draft');
  assert.deepEqual((await h.status()).record, beforeDraft);
  assert.equal(h.menus.at(-1)!.options[0], '戻る（変更なし）');
  for (const width of [16, 36, 100]) for (const line of h.render(width)) assert.ok(visibleWidth(line) <= width);
  for (const screen of h.inspections) { assert.ok(screen.length <= 27); for (const line of screen) assert.ok(visibleWidth(line) <= 36); }
});

test('actual source changes invalidate evidence/acceptance, reject stale model snapshots and open judgment dialogs; tool activity exposes unknown freshness', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mentor-integration-'));
  try {
    execFileSync('git', ['-C', dir, 'init', '-q']);
    writeFileSync(join(dir, 'source.ts'), 'original');
    execFileSync('git', ['-C', dir, 'add', 'source.ts']);
    const h = harness(SessionManager.inMemory(), dir);
    await implementation(h);
    let status = await h.status();
    const evidence = { type: 'unitEvidence', unitId: 1, revision: 1, sourceHash: status.sourceObservation.source.hash, entries: [{ expectationId: 'E1', observation: '入力を拒否した', references: ['check.ts:5'], method: 'substitute', limitations: 'fake APIのみ' }], concerns: '実API未検証' };
    assert.equal((await h.record(evidence)).isError, undefined);
    await h.command('unit-go:judgment');
    h.choices.push('このスコープを受け入れる'); h.edits.push('代替対象だけで受け入れる'); h.confirmations.push(true); await h.command('unit-judge');
    status = await h.status();
    assert.equal(unitJudgment(status.record.units[0], status.sourceObservation)?.decision, 'accept');
    const priorSnapshot = status.snapshot;
    writeFileSync(join(dir, 'new.ts'), 'untracked source change');
    status = await h.status();
    assert.equal(unitJudgment(status.record.units[0], status.sourceObservation), undefined);
    assert.match(evidenceFreshness(status.record.units[0], status.sourceObservation), /古い/);
    assert.equal((await h.record(evidence, priorSnapshot)).isError, true);
    let resolve!: (ok: boolean) => void;
    h.inspector = () => new Promise(done => { resolve = done; });
    const dialog = h.command('unit-judge');
    unlinkSync(join(dir, 'source.ts'));
    resolve(true); await dialog;
    assert.match(h.notices.at(-1)!, /state changed/);
    assert.equal((await h.status()).record.units[0].judgments.length, 1);
    h.inspector = undefined;
    await h.emit('tool_execution_start', { toolCallId: 'write-1', toolName: 'bash' });
    status = await h.status();
    assert.equal(status.sourceObservation.source, undefined);
    assert.match(h.render(100).join('\n'), /鮮度不明/);
    assert.equal((await h.record(evidence)).isError, true);
    await h.emit('tool_execution_end', { toolCallId: 'write-1', toolName: 'bash' });
    status = await h.status();
    assert.ok(status.sourceObservation.source);
    const context = await h.emit('context', { messages: [] });
    for (const line of location(status.record, status.sourceObservation)) assert.ok(context.messages[0].content.includes(line));
    const base = h.manager.getLeafId()!;
    h.choices.push('修正を依頼する'); h.edits.push('実APIを確認したい'); h.confirmations.push(true); await h.command('unit-judge');
    h.manager.branch(base); await h.emit('session_tree');
    assert.equal((await h.status()).record.units[0].judgments.length, 1);
    await h.command('pause');
    assert.equal((await h.emit('context', { messages: [] })).messages.length, 0);
    assert.equal((await h.record({ type: 'unitReport', unitId: 1, revision: 1, text: '準備完了' })).isError, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('guided card prepares without authority; one chosen edge bundles exact records and progress', async () => {
  const h = harness();
  await h.emit('session_start'); await h.command('resume');
  const offer = async (edge: object) => {
    const before = (await h.status()).record;
    const result = await h.next({ summary: '会話から整理した候補', unresolved: '実環境の挙動は未確認', edge });
    assert.equal(result.isError, undefined, JSON.stringify(result.details));
    const after = (await h.status()).record;
    assert.equal(after.whole, before.whole);
    assert.equal(after.activeIssue, before.activeIssue);
    assert.deepEqual(after.issues, before.issues);
    assert.deepEqual(after.units, before.units);
    const count = h.manager.getEntries().length;
    h.cardResults.push('edge'); await h.command();
    assert.equal(h.manager.getEntries().length, count + 1, 'one atomic state entry per edge');
    assert.equal(h.requests.length, 0, 'choosing an edge does not force inference');
  };
  await offer({ type: 'goals', goal: '安全な入力を設計する', constraints: 'API維持' });
  await offer({ type: 'issue', text: '入力検証' });
  assert.equal((await h.status()).record.issues[0].currentRevision, null);
  await offer({ type: 'critique', text: '境界で入力を検証する' });
  let s = (await h.status()).record;
  assert.equal(s.issues[0].inner, 'critique');
  assert.equal(s.issues[0].revisions[0].text, '境界で入力を検証する');
  assert.equal(s.issues[0].judgments.length, 0, 'review target is not adoption');
  await offer({ type: 'decide' });
  await offer({ type: 'adopt', note: '境界を明示する' });
  s = (await h.status()).record;
  assert.equal(s.issues[0].judgments[0].decision, 'adopt');
  assert.equal(s.whole, 'implementation');
  assert.equal(s.units.length, 0, 'direction is not implementation authorization');
  await offer({ type: 'start', contract: unitContract });
  s = (await h.status()).record;
  assert.equal(s.units[0].phase, 'implementing');
  assert.deepEqual(s.units[0].revisions[0].contract, unitContract);
  await offer({ type: 'inspect' });
  assert.equal((await h.status()).record.units[0].phase, 'examination');
  await offer({ type: 'accept', note: '証拠未提出と本番未確認を留保' });
  s = (await h.status()).record;
  assert.equal(s.units[0].judgments.at(-1).decision, 'accept');
  assert.equal(s.units[0].judgments.at(-1).source.hash, (await h.status()).sourceObservation.source.hash);
  assert.deepEqual(s.units[0].judgments.at(-1).evidenceIds, []);
  assert.equal(s.activeUnit, 1, 'acceptance never starts a next unit');
  await offer({ type: 'review' });
  await offer({ type: 'finish' });
  assert.equal((await h.status()).record.enabled, false);
});

test('guided cancellation/chat and stale state/source/session dialogs never apply or partially register an edge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mentor-card-'));
  try {
    execFileSync('git', ['-C', dir, 'init', '-q']);
    writeFileSync(join(dir, 'code.ts'), 'before');
    execFileSync('git', ['-C', dir, 'add', '.']);
    const h = harness(SessionManager.inMemory(), dir);
    await h.emit('session_start'); await h.command('resume');
    const p = { summary: '目標を整理', unresolved: '本番未確認', edge: { type: 'goals', goal: '安全な入力', constraints: 'API維持' } };
    await h.next(p);
    const before = (await h.status()).record;
    const count = h.manager.getEntries().length;
    h.cardResults.push('continue'); await h.command();
    await h.emit('context', { messages: [{ role: 'user', content: 'OK、質問がある', timestamp: 1 }] });
    await h.emit('agent_end');
    assert.deepEqual((await h.status()).record, before);
    assert.equal(h.manager.getEntries().length, count);
    assert.equal(h.requests.length, 0);
    let resolve!: (value: string | undefined) => void;
    h.inspector = () => new Promise(done => { resolve = done; });
    let dialog = h.command();
    writeFileSync(join(dir, 'code.ts'), 'changed while card open');
    resolve('edge'); await dialog;
    assert.deepEqual((await h.status()).record, before);
    assert.match(h.notices.at(-1)!, /state changed/);
    await h.next(p);
    dialog = h.command();
    await h.record({ type: 'proposal', text: '候補後の別記録' });
    resolve('edge'); await dialog;
    assert.equal((await h.status()).record.goal, '');
    assert.match(h.notices.at(-1)!, /state changed/);
    await h.next(p);
    dialog = h.command();
    h.manager = SessionManager.inMemory();
    await h.emit('session_start');
    resolve('edge'); await dialog;
    assert.equal(h.manager.getEntries().length, 0);
    assert.equal((await h.status()).record.goal, '');
    assert.match(h.notices.at(-1)!, /session changed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('legacy contextual menu remains available only as an explicit advanced shortcut', async () => {
  const h = await prepared();
  h.choices.push('論点の検討', '仮説形成'); await h.command('phase');
  const before = (await h.status()).record;
  h.choices.push('仮説を作成・改訂…', '戻る', '記録を見る…', '戻る', '移動・その他…', '全体の移動先を選ぶ…', '戻る（変更なし）', '戻る', '閉じる（変更なし）');
  await h.command('advanced');
  assert.deepEqual((await h.status()).record, before);
  const main = h.menus.findLast(m => m.options.includes('仮説を作成・改訂…'))!;
  assert.equal(main.options[0], '閉じる（変更なし）');
  assert.ok(main.options.includes('批判・弁護へ移る'));
  assert.ok(main.options.includes('記録を見る…'));
  assert.ok(main.options.includes('移動・その他…'));
  assert.ok(!main.options.includes('制約を編集'));
  assert.ok(!main.options.includes('現在の仮説を判断する'));
  assert.ok(main.options.length <= 8);
  h.choices.push('批判・弁護へ移る'); await h.command('advanced');
  assert.equal((await h.status()).record.issues[0].inner, 'critique');
  await h.command('advanced');
  assert.ok(h.menus.at(-1)!.options.includes('仮説の判断へ移る'));
});
