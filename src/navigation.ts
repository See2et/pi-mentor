import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, SelectList, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';

export function menuDirection(data: string): -1 | 0 | 1 {
  if (matchesKey(data, Key.up) || matchesKey(data, 'k')) return -1;
  if (matchesKey(data, Key.down) || matchesKey(data, 'j')) return 1;
  return 0;
}

export async function selectMenu(ctx: ExtensionCommandContext, title: string, options: string[]): Promise<string | undefined> {
  if (!options.length) return undefined;
  if (ctx.mode !== 'tui') return ctx.ui.select(title, options);
  return ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
    const createList = (maxVisible: number) => new SelectList(options.map((label, n) => ({ value: String(n), label: label.replace(/[\r\n\t]/g, ' ') })), maxVisible, {
      selectedPrefix: text => theme.fg('accent', text),
      selectedText: text => theme.fg('accent', text),
      description: text => theme.fg('muted', text),
      scrollInfo: text => theme.fg('muted', text),
      noMatch: text => theme.fg('muted', text),
    });
    let list = createList(1);
    const bind = () => {
      list.onSelect = item => done(options[Number(item.value)]);
      list.onCancel = () => done(undefined);
    };
    bind();
    return {
      render(width: number) {
        width = Math.max(1, width);
        const header = wrapTextWithAnsi(title.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ''), width).slice(0, Math.max(1, tui.terminal.rows - 5));
        // Reserve space for the title, footer, scroll indicator and overlay margins.
        const index = Number(list.getSelectedItem()!.value);
        list = createList(Math.max(1, tui.terminal.rows - header.length - 4));
        list.setSelectedIndex(index);
        bind();
        return [
          ...header.map(line => theme.fg('accent', line)),
          ...list.render(width).map(line => truncateToWidth(line, width)),
          theme.fg('muted', truncateToWidth('↑/k: 上 / ↓/j: 下 / Enter: 決定 / Esc: 取消', width)),
        ];
      },
      invalidate() { list.invalidate(); },
      handleInput(data: string) {
        const direction = menuDirection(data);
        if (direction) {
          const index = Number(list.getSelectedItem()!.value);
          list.setSelectedIndex((index + direction + options.length) % options.length);
        } else list.handleInput(data);
        tui.requestRender();
      },
    };
  }, { overlay: true, overlayOptions: { width: '100%', maxHeight: '100%', margin: { top: 1, bottom: 1, left: 0, right: 0 } } });
}

export async function confirmMenu(ctx: ExtensionCommandContext, title: string, text: string): Promise<boolean> {
  if (ctx.mode !== 'tui') return ctx.ui.confirm(title, text);
  return await selectMenu(ctx, `${title}\n${text}`, ['Yes', 'No']) === 'Yes';
}
