import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import mentorExtension from '../index.ts';
import { location } from '../src/domain.ts';

type Handler = (...args: any[]) => any;
function harness(manager = SessionManager.inMemory()) {
  const events = new Map<string, Handler>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const h = {
    manager, events, tools, commands,
    choices: [] as (string | undefined)[], edits: [] as (string | undefined)[], confirmations: [] as boolean[],
    notices: [] as string[], requests: [] as string[],
    widget: undefined as Handler | undefined,
    editor: undefined as (() => Promise<string | undefined>) | undefined,
    async emit(name: string, event: object = {}) { return events.get(name)!({ type: name, ...event }, h.ctx()); },
    ctx(): ExtensionCommandContext {
      return {
        sessionManager: h.manager, mode: 'tui', hasUI: true, isIdle: () => true,
        ui: {
          select: async () => h.choices.shift(),
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
  assert.deepEqual(await h.status(), before);
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
  assert.ok(h.render(80).join('\n').includes('未判断'));
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
  assert.deepEqual(await h.status(), before);
  assert.equal(h.requests.length, 1);
  assert.match(h.requests[0], /this response only/);
  await h.command('pause');
  const paused = await h.status();
  assert.equal((await h.record({ type: 'proposal', text: '禁止' })).isError, true);
  const context = await h.emit('context', { messages: [] });
  assert.deepEqual(context.messages, []);
  await h.command('hint');
  assert.deepEqual(await h.status(), paused);
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
  assert.ok(h.render(100).join('\n').includes('全体目標・制約'));
  for (const width of [16, 32, 80, 120]) {
    for (const line of h.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
    assert.match(h.render(width).join('\n'), /r1/);
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
