import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { menuDirection } from "./navigation.ts";

export type CardChoice = "continue" | "edge" | "other";
export type CardSummary = { target: string; effect: string; caution: string };
export const plain = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
const singleLine = (text: string) => plain(text).replace(/[\r\n\t]+/g, " ");

export async function actionCard(
  ctx: ExtensionContext,
  title: string,
  body: string,
  action: string,
  approval?: { signal?: AbortSignal },
  summary?: CardSummary,
): Promise<CardChoice | undefined> {
  const options: [CardChoice, string][] = approval
    ? [
        ["continue", "取り消す（変更なし）"],
        ["edge", `今回だけ承認: ${action}`],
      ]
    : [
        ["continue", "議論を続ける（変更なし）"],
        ["edge", action],
        ["other", "その他…"],
      ];
  if (approval && (!ctx.hasUI || ctx.mode !== "tui" || approval.signal?.aborted)) return;
  if (ctx.mode !== "tui") {
    if ((await ctx.ui.editor(`${title}（閲覧のみ。保存で選択へ／Esc取消）`, body)) === undefined)
      return;
    const selected = await ctx.ui.select(
      title,
      options.map(([, label]) => label),
    );
    return options.find(([, label]) => label === selected)?.[0];
  }
  let cancel: (() => void) | undefined;
  try {
    return await ctx.ui.custom<CardChoice | undefined>(
      (tui, theme, _keys, done) => {
        cancel = () => done(undefined);
        approval?.signal?.addEventListener("abort", cancel, { once: true });
        if (approval?.signal?.aborted) cancel();
        let selected = 0,
          top = 0,
          page = 1,
          count = 0;
        let details = false,
          pinnedEnd = false;
        const back = () => {
          details = false;
          selected = 0;
        };
        return {
          render(width: number) {
            width = Math.max(1, width);
            const inner = Math.max(1, width - 4);
            const height = Math.max(4, tui.terminal.rows - 2);
            const limit = height - 2;
            const fit = (text: string) => truncateToWidth(singleLine(text), inner);
            const limited = (text: string, rows: number) => {
              const lines = wrapTextWithAnsi(singleLine(text), inner);
              if (lines.length <= rows) return lines;
              return [
                ...lines.slice(0, rows - 1),
                truncateToWidth(lines.slice(rows - 1).join(""), inner),
              ];
            };
            let content: string[];
            if (details) {
              const lines = wrapTextWithAnsi(plain(body), inner);
              count = lines.length;
              page = Math.max(1, limit - 2);
              top = pinnedEnd
                ? Math.max(0, count - page)
                : Math.min(top, Math.max(0, count - page));
              content = [
                ...lines.slice(top, top + page),
                theme.fg(
                  "muted",
                  fit(`全文 ${top + 1}–${Math.min(top + page, count)}/${count} · PgUp/Dn Home/End`),
                ),
                theme.fg("accent", fit("Enter / Esc: 戻る（未承認）")),
              ];
            } else {
              const footer = [
                ...options.map(([, label], n) =>
                  theme.fg(
                    selected === n ? "accent" : "muted",
                    fit(`${selected === n ? "›" : " "} ${label}`),
                  ),
                ),
                theme.fg("muted", fit("d: 詳細 / ↑↓: 選択 / Enter: 決定 / Esc: 取消")),
              ];
              const roomy = height >= 18;
              const available = Math.max(0, limit - footer.length - (roomy ? 2 : 0));
              const overview = [
                ...limited(action, 2).map((line) => theme.fg("accent", line)),
                ...limited(`対象: ${summary?.target ?? title}`, 2),
                ...limited(`効果: ${summary?.effect ?? "相談の続きを選びます。"}`, 2),
                ...limited(summary?.caution ?? "正確な内容・留保は d で確認", 2).map((line) =>
                  theme.fg("warning", line),
                ),
              ];
              content = roomy
                ? ["", ...overview.slice(0, available), "", ...footer]
                : [...overview.slice(0, available), ...footer];
            }
            const border = (text: string) => theme.fg("border", text);
            const heading = fit(
              details
                ? "Mentor · 詳細（閲覧のみ）"
                : approval
                  ? "Mentor · 承認待ち"
                  : "Mentor · 次の一手",
            );
            return [
              border("╭─") +
                theme.fg("accent", heading) +
                border("─".repeat(Math.max(0, width - 3 - visibleWidth(heading))) + "╮"),
              ...content
                .slice(0, limit)
                .map(
                  (line) =>
                    border("│ ") +
                    line +
                    " ".repeat(Math.max(0, inner - visibleWidth(line))) +
                    border(" │"),
                ),
              border(`╰${"─".repeat(Math.max(0, width - 2))}╯`),
            ].map((line) => theme.bg("customMessageBg", truncateToWidth(line, width)));
          },
          invalidate() {},
          handleInput(data: string) {
            if (matchesKey(data, Key.ctrl("c"))) {
              done(undefined);
              return;
            }
            if (details) {
              if (
                matchesKey(data, Key.escape) ||
                matchesKey(data, Key.enter) ||
                matchesKey(data, "d")
              ) {
                back();
              } else {
                if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.up)) {
                  pinnedEnd = false;
                  top = Math.max(0, top - (matchesKey(data, Key.up) ? 1 : page));
                }
                if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.down)) {
                  pinnedEnd = false;
                  top = Math.min(
                    Math.max(0, count - page),
                    top + (matchesKey(data, Key.down) ? 1 : page),
                  );
                }
                if (matchesKey(data, Key.home)) {
                  pinnedEnd = false;
                  top = 0;
                }
                if (matchesKey(data, Key.end)) pinnedEnd = true;
              }
            } else {
              if (matchesKey(data, Key.escape)) {
                done(undefined);
                return;
              }
              if (matchesKey(data, Key.enter)) {
                done(options[selected][0]);
                return;
              }
              if (matchesKey(data, "d")) {
                details = true;
                top = 0;
                pinnedEnd = false;
              }
              const direction = menuDirection(data) || (matchesKey(data, Key.tab) ? 1 : 0);
              if (direction) selected = (selected + direction + options.length) % options.length;
            }
            tui.requestRender();
          },
        };
      },
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: 76, maxHeight: "100%", margin: 1 },
      },
    );
  } finally {
    if (cancel) approval?.signal?.removeEventListener("abort", cancel);
  }
}
