import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';

// A bounded plain-text inspector. Enter only returns to the caller; it never accepts an object.
export async function inspect(ctx: ExtensionCommandContext, title: string, text: string): Promise<boolean> {
  if (ctx.mode !== 'tui') {
    // RPC has native editors but no custom component. Edits here are intentionally discarded.
    return (await ctx.ui.editor(`${title}（閲覧のみ。保存で戻る／Esc取消）`, text)) !== undefined;
  }
  return ctx.ui.custom<boolean>((tui, theme, _keys, done) => {
    let top = 0;
    let pinnedEnd = false;
    let page = 1;
    let lines: string[] = [];
    return {
      render(width: number) {
        const safe = text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
        lines = wrapTextWithAnsi(safe, Math.max(1, width));
        page = Math.max(1, tui.terminal.rows - 5);
        top = pinnedEnd ? Math.max(0, lines.length - page) : Math.min(top, Math.max(0, lines.length - page));
        return [
          theme.fg('accent', truncateToWidth(title, width)),
          ...lines.slice(top, top + page),
          theme.fg('muted', truncateToWidth(`${top + 1}–${Math.min(top + page, lines.length)} / ${lines.length} · ↑↓ PgUp/PgDn Home/End`, width)),
          theme.fg('muted', truncateToWidth('Enter: 戻る（未確定） / Esc: 取消', width)),
        ];
      },
      invalidate() {},
      handleInput(data: string) {
        if (matchesKey(data, Key.escape)) { done(false); return; }
        if (matchesKey(data, Key.enter)) { done(true); return; }
        if ([Key.up, Key.down, Key.pageUp, Key.pageDown, Key.home].some(key => matchesKey(data, key))) pinnedEnd = false;
        if (matchesKey(data, Key.up)) top = Math.max(0, top - 1);
        if (matchesKey(data, Key.down)) top = Math.min(Math.max(0, lines.length - page), top + 1);
        if (matchesKey(data, Key.pageUp)) top = Math.max(0, top - page);
        if (matchesKey(data, Key.pageDown)) top = Math.min(Math.max(0, lines.length - page), top + page);
        if (matchesKey(data, Key.home)) top = 0;
        if (matchesKey(data, Key.end)) { top = Math.max(0, lines.length - page); pinnedEnd = true; }
        tui.requestRender();
      },
    };
  }, { overlay: true, overlayOptions: { width: '100%', maxHeight: '100%', margin: { top: 1, bottom: 1, left: 0, right: 0 } } });
}
