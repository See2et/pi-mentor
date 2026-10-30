import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { selectMenu, confirmMenu } from '../src/navigation.ts';
import { actionCard } from '../src/card.ts';

function dialog<T>(open: (ctx: ExtensionCommandContext) => Promise<T>) {
  let component: { render(width: number): string[]; handleInput(data: string): void };
  let rows = 12;
  const result = open({ mode: 'tui', ui: { custom: (factory: any) => new Promise(resolve => {
    component = factory({ terminal: { get rows() { return rows; } }, requestRender() {} }, { fg: (_: string, text: string) => text }, {}, resolve);
  }) } } as unknown as ExtensionCommandContext);
  return { result, render: (width = 50) => component.render(width), key: (data: string) => component.handleInput(data), resize: (height: number) => { rows = height; } };
}

for (const [up, down] of [['\x1b[A', '\x1b[B'], ['j', 'k'], ['\x1b[106u', '\x1b[107u']]) {
  test(`selection wraps in both directions with ${JSON.stringify([up, down])}`, async () => {
    const d = dialog(ctx => selectMenu(ctx, 'Choose', ['first', 'middle', 'last']));
    d.render();
    d.key(up);
    assert.ok(d.render().some(line => line.includes('→ last')));
    d.key(down);
    assert.ok(d.render().some(line => line.includes('→ first')));
    d.key(down);
    d.key('\r');
    assert.equal(await d.result, 'middle');
  });
  test(`action card uses the same directions with ${JSON.stringify([up, down])}`, async () => {
    const d = dialog(ctx => actionCard(ctx, 'Card', 'Details', 'Act'));
    d.render();
    d.key(up);
    assert.ok(d.render().some(line => line.includes('› その他')));
    d.key(down);
    assert.ok(d.render().some(line => line.includes('› 議論')));
    d.key(down);
    d.key('\r');
    assert.equal(await d.result, 'edge');
  });
}

test('long selection stays visible after wrapping and resizing; cancel has no selection', async () => {
  const d = dialog(ctx => selectMenu(ctx, '選択\n二行の題名', Array.from({ length: 30 }, (_, n) => `item-${n}`)));
  d.render(); d.key('j');
  for (const width of [16, 36]) {
    d.resize(9);
    const lines = d.render(width);
    assert.ok(lines.some(line => line.includes('→ item-29')));
    assert.ok(lines.length <= 9);
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
  }
  d.key('\x1b');
  assert.equal(await d.result, undefined);
});

test('singleton and empty menus never produce an invalid selection', async () => {
  const d = dialog(ctx => selectMenu(ctx, 'Only', ['only']));
  d.key('j'); d.key('k'); d.key('\r');
  assert.equal(await d.result, 'only');
  assert.equal(await selectMenu({ mode: 'tui' } as ExtensionCommandContext, 'Empty', []), undefined);
});

test('multiline labels render as bounded single lines without changing option identity', async () => {
  const original = 'first\nsecond\r\nthird\tfourth';
  const d = dialog(ctx => selectMenu(ctx, 'Choose', ['first second  third fourth', original]));
  d.key('j');
  for (const width of [16, 80]) {
    const lines = d.render(width);
    assert.ok(lines.length <= 12);
    for (const line of lines) {
      assert.doesNotMatch(line, /[\r\n\t]/);
      assert.ok(visibleWidth(line) <= width);
    }
  }
  d.key('\r');
  assert.equal(await d.result, original, 'display normalization must not select the other identical-looking option');
});

test('confirmation accepts only Yes and preserves cancellation', async () => {
  const yes = dialog(ctx => confirmMenu(ctx, 'Confirm', 'Exact content'));
  yes.key('\r'); assert.equal(await yes.result, true);
  const no = dialog(ctx => confirmMenu(ctx, 'Confirm', 'Exact content'));
  no.key('j'); no.key('\r'); assert.equal(await no.result, false);
  const cancel = dialog(ctx => confirmMenu(ctx, 'Confirm', 'Exact content'));
  cancel.key('\x1b'); assert.equal(await cancel.result, false);
});

test('RPC keeps native selection/confirmation and card editor fallback', async () => {
  const calls: string[] = [];
  const ctx = { mode: 'rpc', ui: {
    select: async (_: string, options: string[]) => { calls.push('select'); return options[1]; },
    confirm: async () => { calls.push('confirm'); return false; },
    editor: async (_: string, body: string) => { calls.push('editor'); return body; },
  } } as unknown as ExtensionCommandContext;
  assert.equal(await selectMenu(ctx, 'Choose', ['first', 'last']), 'last');
  assert.equal(await confirmMenu(ctx, 'Confirm', 'Text'), false);
  assert.equal(await actionCard(ctx, 'Card', 'Body', 'Act'), 'edge');
  assert.deepEqual(calls, ['select', 'confirm', 'editor', 'select']);
});
