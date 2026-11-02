import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { menuDirection } from './navigation.ts';

export type CardChoice = 'continue' | 'edge' | 'other';
export const plain = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
export async function actionCard(ctx: ExtensionContext, title: string, body: string, action: string, approval?: { signal?: AbortSignal }): Promise<CardChoice | undefined> {
  const options: [CardChoice, string][] = approval
    ? [['continue', '取り消す（変更なし）'], ['edge', `今回だけ承認: ${action}`]]
    : [['continue', '議論を続ける（変更なし）'], ['edge', action], ['other', 'その他…']];
  if (approval && (!ctx.hasUI || ctx.mode !== 'tui' || approval.signal?.aborted)) return;
  if (ctx.mode !== 'tui') {
    if (await ctx.ui.editor(`${title}（閲覧のみ。保存で選択へ／Esc取消）`, body) === undefined) return;
    const selected = await ctx.ui.select(title, options.map(([, label]) => label));
    return options.find(([, label]) => label === selected)?.[0];
  }
  let cancel: (() => void) | undefined;
  try {
    return await ctx.ui.custom<CardChoice | undefined>((tui, theme, _keys, done) => {
    cancel = () => done(undefined);
    approval?.signal?.addEventListener('abort', cancel, { once: true });
    if (approval?.signal?.aborted) cancel();
    let selected = 0, top = 0, page = 1, count = 0;
    let pinnedEnd = false;
    return {
      render(width: number) {
        width = Math.max(1, width);
        const footer = options.flatMap(([, label], n) => wrapTextWithAnsi(`${selected === n ? '›' : ' '} ${plain(label)}`, width).map(line => theme.fg(selected === n ? 'accent' : 'muted', line)));
        const lines = wrapTextWithAnsi(plain(body), width);
        count = lines.length;
        page = Math.max(1, tui.terminal.rows - footer.length - 6);
        top = pinnedEnd ? Math.max(0, count - page) : Math.min(top, Math.max(0, count - page));
        return [
          theme.fg('accent', truncateToWidth(plain(title).replace(/[\r\n\t]/g, ' '), width)),
          ...lines.slice(top, top + page),
          theme.fg('muted', truncateToWidth(`詳細 ${top + 1}–${Math.min(top + page, count)}/${count} · PgUp/Dn Home/End`, width)),
          ...footer,
          theme.fg('muted', truncateToWidth('↑/j: 上 / ↓/k: 下 / Enter: 実行 / Esc: 閉じる', width)),
        ];
      },
      invalidate() {},
      handleInput(data: string) {
        if (matchesKey(data, Key.escape)) { done(undefined); return; }
        if (matchesKey(data, Key.enter)) { done(options[selected][0]); return; }
        const direction = menuDirection(data) || (matchesKey(data, Key.tab) ? 1 : 0);
        if (direction) selected = (selected + direction + options.length) % options.length;
        if (matchesKey(data, Key.pageUp)) { pinnedEnd = false; top = Math.max(0, top - page); }
        if (matchesKey(data, Key.pageDown)) { pinnedEnd = false; top = Math.min(Math.max(0, count - page), top + page); }
        if (matchesKey(data, Key.home)) { pinnedEnd = false; top = 0; }
        if (matchesKey(data, Key.end)) { pinnedEnd = true; }
        tui.requestRender();
      },
    };
  }, { overlay: true, overlayOptions: { width: '100%', maxHeight: '100%', margin: { top: 1, bottom: 1, left: 0, right: 0 } } });
  } finally {
    if (cancel) approval?.signal?.removeEventListener('abort', cancel);
  }
}
