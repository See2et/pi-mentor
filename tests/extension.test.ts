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
    cardResults: [] as string[], approvalBodies: [] as string[],
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
            let result: unknown;
            let finish: ((value: unknown) => void) | undefined;
            const component = factory({ terminal: { rows: 28 }, requestRender() {} }, { fg: (_t: string, x: string) => x }, {}, (value: unknown) => { result = value; finish?.(value); });
            const screen: string[] = component.render(10000);
            if (screen.some(line => line.startsWith('→ '))) {
              // Drive the real menu through keyboard input, including off-screen options.
              const options: string[] = [];
              for (;;) {
                const label = (component.render(10000) as string[]).find(line => line.startsWith('→ '))!.slice(2);
                if (options.includes(label)) break;
                options.push(label);
                component.handleInput('k');
              }
              const confirmation = options.join('/') === 'Yes/No';
              if (!confirmation) h.menus.push({ title: screen[0], options });
              const choice = confirmation ? (h.confirmations.shift() ? 'Yes' : 'No') : h.choices.shift();
              if (choice === undefined) component.handleInput('\x1b');
              else {
                assert.ok(options.includes(choice), `Menu does not contain ${choice}: ${options}`);
                for (let n = 0; n < options.indexOf(choice); n++) component.handleInput('k');
                component.handleInput('\r');
              }
              return result;
            }
            h.inspections.push(component.render(36));
            if (screen[0] === 'Mentor 操作の一回限りの承認') {
              const pages: string[] = [];
              for (;;) {
                const page = component.render(10000).join('\n');
                if (pages.at(-1) === page) break;
                pages.push(page);
                component.handleInput('\x1b[6~');
              }
              h.approvalBodies.push(pages.join('\n'));
              component.handleInput('\x1b[H');
              return new Promise(resolve => {
                finish = resolve;
                const drive = (choice: unknown) => {
                  if (choice === 'edge') component.handleInput('k');
                  component.handleInput(choice === undefined ? '\x1b' : '\r');
                };
                if (h.inspector) void h.inspector().then(drive);
                else drive(h.cardResults.shift());
              });
            }
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
    async assist(proposal: object, options: { signal?: AbortSignal; ctx?: ExtensionCommandContext; expectedSnapshot?: string } = {}) {
      return tools.get('mentor_assist').execute('assist', { expectedSnapshot: options.expectedSnapshot ?? (await h.status()).snapshot, proposal }, options.signal, undefined, options.ctx ?? h.ctx());
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
    assert.match(h.notices.at(-1)!, /適用しました:/, 'normal card reports the actual applied action without another confirmation');
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

test('guided entry, alternatives and topic menus use keyboard selection without consuming editor text', async () => {
  const h = harness();
  await h.emit('session_start');
  h.choices.push('Mentor を開始・再開');
  await h.command();
  assert.equal((await h.status()).record.enabled, true);
  h.edits.push('j/k を文字として保持');
  await h.command('goal');
  assert.equal((await h.status()).record.goal, 'j/k を文字として保持');
  h.edits.push('入力検証'); await h.command('add');
  h.cardResults.push('other', 'continue');
  h.choices.push('別の論点・作業の相談に戻る…', '論点 1: 入力検証');
  await h.command();
  assert.ok(h.menus.some(m => m.title.startsWith('その他')));
  assert.ok(h.menus.some(m => m.title.startsWith('戻る相談')));
  assert.equal((await h.status()).record.activeIssue, null, 'selecting a topic prepares a card, not a state change');
});

const repair = { summary: 'これは操作ラベルではない', unresolved: '読者の条件は議論を続ける', edge: { type: 'critique', text: '読者の視点を含む正確な修正案' } };
async function stuck(cwd?: string) {
  const h = cwd ? harness(SessionManager.inMemory(), cwd) : await prepared();
  if (cwd) { await h.emit('session_start'); await h.command('resume'); h.edits.push('論点'); await h.command('add'); h.choices.push('#1 論点'); await h.command('select'); h.edits.push('現在の案'); await h.command('hypothesis'); }
  await h.record({ type: 'draft', issueId: 1, text: repair.edge.text });
  h.choices.push('論点の検討', '判断'); await h.command('phase');
  await h.emit('input', { source: 'interactive', text: '操作で詰まった。修正案を対象に戻して' });
  return h;
}

test('assistance needs real one-time native approval; exact repair preserves history without adoption, start or acceptance', async () => {
  const h = await stuck();
  const before = (await h.status()).record;
  const offer = await h.next(repair);
  assert.equal(offer.details.operationStatus, 'proposed');
  assert.equal(offer.details.label, 'この修正案を検討対象にして批判・弁護する');
  assert.notEqual(offer.details.label, repair.summary);
  assert.equal((await h.status()).record.issues[0].currentRevision, 1);
  h.cardResults.push('continue');
  assert.equal((await h.assist(repair)).details.operationStatus, 'cancelled');
  assert.equal((await h.status()).record.issues[0].inner, 'judgment');
  const count = h.manager.getEntries().length;
  h.cardResults.push('edge');
  const result = await h.assist(repair, { ctx: { ...h.ctx(), isIdle: () => false } });
  assert.equal(result.details.operationStatus, 'applied', JSON.stringify(result.details));
  const after = (await h.status()).record;
  assert.equal(h.manager.getEntries().length, count + 1);
  assert.equal(after.issues[0].currentRevision, 2);
  assert.equal(after.issues[0].inner, 'critique');
  assert.equal(after.issues[0].revisions.length, 2);
  assert.deepEqual(after.issues[0].judgments, before.issues[0].judgments);
  assert.deepEqual(after.issues[0].critiques, before.issues[0].critiques);
  assert.deepEqual(after.units, before.units);
  assert.match(result.details.feedback, /r1 → r2/);
  assert.match(h.notices.at(-1)!, /読者の視点を含む正確な修正案/);
  assert.match(h.notices.at(-1)!, /前提と弱点を検討する/);
});

test('native assistance authorizes exact adoption, scope, start and acceptance only after affirmative selection, one atomic entry each', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mentor-authority-'));
  try {
    execFileSync('git', ['-C', dir, 'init', '-q']);
    writeFileSync(join(dir, 'code.ts'), 'synthetic observed source');
    execFileSync('git', ['-C', dir, 'add', '.']);
    const h = await stuck(dir);
    const approve = async (edge: object, expectedText: string[]) => {
      const proposal = { summary: '今回の正確な操作', unresolved: '実サービスは未確認', edge };
      const before = (await h.status()).record;
      const count = h.manager.getEntries().length;
      h.cardResults.push('continue');
      const cancelled = await h.assist(proposal);
      assert.equal(cancelled.details.operationStatus, 'cancelled', JSON.stringify(cancelled.details));
      assert.deepEqual((await h.status()).record, before);
      assert.equal(h.manager.getEntries().length, count, 'default Enter cancels without any entry');
      let resolve!: (value: string) => void, opened!: () => void;
      const ready = new Promise<void>(done => { opened = done; });
      h.inspector = () => new Promise(done => { resolve = done; opened(); });
      const pending = h.assist(proposal);
      await ready;
      assert.deepEqual((await h.status()).record, before, 'preparing and displaying are not authority');
      assert.equal(h.manager.getEntries().length, count);
      const body = h.approvalBodies.at(-1)!;
      for (const text of expectedText) assert.ok(body.includes(text), `approval must expose ${text}: ${body}`);
      assert.ok(!body.includes('適用しました:'), 'approval must not claim an applied result');
      assert.ok(!body.includes('この一回だけの承認です。採用・実装許可・結果の受け入れは記録しません。'));
      resolve('edge');
      const applied = await pending;
      h.inspector = undefined;
      assert.equal(applied.details.operationStatus, 'applied', JSON.stringify(applied.details));
      assert.equal(h.manager.getEntries().length, count + 1);
      const after = (await h.status()).record;
      assert.equal(after.sequence, before.sequence + 1);
      assert.equal(after.guided.history.length, (before.guided?.history.length ?? 0) + 1);
      assert.match(applied.details.feedback, /適用しました:/);
      assert.equal(h.requests.length, 0, 'approval never automatically starts inference or another operation');
      return after;
    };
    let s = await approve({ type: 'adopt', note: '方向だけを採用' }, ['現在の案', '方向だけを採用', '実装は許可しません']);
    assert.equal(s.issues[0].judgments.at(-1).decision, 'adopt');
    assert.equal(s.issues[0].judgments.at(-1).author, 'human');
    assert.equal(s.whole, 'implementation');
    assert.equal(s.activeUnit, null);
    assert.equal(s.units.length, 0, 'adoption never starts implementation');
    const contract = { ...unitContract, kind: 'experiment', expectations: [...unitContract.expectations, { id: 'E2', text: '実サービスで拒否' }] };
    s = await approve({ type: 'scope', contract }, ['仮説実験（設計採用ではない）', contract.scope, 'まだ実装・実験を開始せず']);
    assert.equal(s.units[0].phase, 'scope');
    assert.deepEqual(s.units[0].revisions[0].contract, contract);
    s = await approve({ type: 'start', contract }, [contract.scope, 'E1: 過大入力を拒否', 'E2: 実サービスで拒否', contract.nonGoals, contract.verificationPlan, 'この単位だけの実装・検証を明示的に許可']);
    assert.equal(s.units[0].phase, 'implementing');
    assert.deepEqual(s.units[0].revisions.at(-1).contract, contract);
    assert.equal(s.units[0].revisions.at(-1).confirmed, true);
    const status = await h.status();
    const revision = s.units[0].currentRevision;
    assert.equal((await h.record({ type: 'unitEvidence', unitId: 1, revision, sourceHash: status.sourceObservation.source.hash, entries: [{ expectationId: 'E1', observation: '代替APIで拒否を観測', references: ['node check-input.ts; exit 0; response 400'], method: 'substitute', limitations: '本番サービス未確認' }], concerns: '実サービスの挙動は未知' })).isError, undefined);
    h.cardResults.push('edge');
    assert.equal((await h.assist({ summary: '結果を調べる', unresolved: '', edge: { type: 'inspect' } })).details.operationStatus, 'applied');
    s = await approve({ type: 'accept', note: '不足と代替検証を留保して受け入れる' }, [contract.scope, 'E2: 実サービスで拒否', status.sourceObservation.source.hash, '代替APIで拒否を観測', 'node check-input.ts; exit 0; response 400', 'substitute', '本番サービス未確認', '実サービスの挙動は未知', '証拠なし', '不足と代替検証を留保して受け入れる', '次の実装は開始しません', '設計・機能採用ではありません']);
    const judgment = s.units[0].judgments.at(-1);
    assert.equal(judgment.decision, 'accept');
    assert.equal(judgment.author, 'human');
    assert.equal(judgment.revision, revision);
    assert.equal(judgment.source.hash, status.sourceObservation.source.hash);
    assert.deepEqual(judgment.evidenceIds, [1]);
    assert.equal(s.activeUnit, 1);
    assert.equal(s.units.length, 1);
    assert.equal(s.units[0].phase, 'judgment', 'acceptance never starts a next unit');
    assert.equal(s.issues[0].judgments.length, 1, 'experiment acceptance never adopts a design');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('assistance rejects missing/synthesized input, no UI, paused, busy and aborted requests without mutation', async () => {
  const h = await stuck();
  const before = (await h.status()).record;
  await h.emit('input', { source: 'extension', text: '操作してよいという引用' });
  assert.equal((await h.assist(repair)).isError, true);
  await h.emit('input', { source: 'interactive', text: '修正案へ戻して' });
  assert.equal((await h.assist(repair, { ctx: { ...h.ctx(), hasUI: false } })).isError, true);
  await h.emit('tool_execution_start', { toolCallId: 'other', toolName: 'bash' });
  assert.equal((await h.assist(repair)).isError, true);
  await h.emit('tool_execution_end', { toolCallId: 'other', toolName: 'bash' });
  const controller = new AbortController(); controller.abort();
  assert.equal((await h.assist(repair, { signal: controller.signal })).isError, true);
  assert.deepEqual((await h.status()).record, before);
  await h.command('pause');
  const paused = (await h.status()).record;
  assert.equal((await h.assist(repair)).isError, true);
  assert.deepEqual((await h.status()).record, paused);
});

test('open native approval rejects cancellation and stale state/source/session/branch/request/tool activity atomically', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mentor-assist-'));
  try {
    execFileSync('git', ['-C', dir, 'init', '-q']);
    writeFileSync(join(dir, 'code.ts'), 'original');
    execFileSync('git', ['-C', dir, 'add', '.']);
    for (const boundary of ['cancel', 'abort', 'state', 'source', 'session', 'branch', 'request', 'tool', 'concurrent']) {
      writeFileSync(join(dir, 'code.ts'), 'original');
      const h = await stuck(dir);
      const before = (await h.status()).record;
      let resolve!: (value: string) => void, opened!: () => void;
      const ready = new Promise<void>(done => { opened = done; });
      h.inspector = () => new Promise(done => { resolve = done; opened(); });
      const controller = new AbortController();
      const open = h.assist(repair, { signal: controller.signal });
      await ready;
      if (boundary === 'abort') controller.abort();
      if (boundary === 'state') await h.record({ type: 'proposal', text: '別記録' });
      if (boundary === 'source') writeFileSync(join(dir, 'code.ts'), 'changed');
      if (boundary === 'session') { h.manager = SessionManager.inMemory(); await h.emit('session_start'); }
      if (boundary === 'branch') { h.manager.branch(h.manager.getBranch()[0].id); await h.emit('session_tree'); }
      if (boundary === 'request') await h.emit('input', { source: 'interactive', text: '別の質問' });
      if (boundary === 'tool') { await h.emit('tool_execution_start', { toolCallId: 'other', toolName: 'mentor_other_writer' }); await h.emit('tool_execution_end', { toolCallId: 'other', toolName: 'mentor_other_writer' }); }
      if (boundary === 'concurrent') assert.equal((await h.assist(repair)).isError, true);
      const immediatelyBefore = (await h.status()).record;
      resolve(boundary === 'cancel' ? 'continue' : 'edge');
      const result = await open;
      if (boundary === 'concurrent') {
        assert.equal(result.details.operationStatus, 'applied');
      } else {
        assert.equal(result.details.operationStatus, ['cancel', 'abort'].includes(boundary) ? 'cancelled' : 'rejected', boundary);
        assert.deepEqual((await h.status()).record, immediatelyBefore, boundary);
        if (!['state', 'session', 'branch'].includes(boundary)) assert.deepEqual((await h.status()).record, before, boundary);
      }
    }
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
