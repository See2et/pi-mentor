import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { State } from "./domain/state.ts";
import { activeIssue, activeUnit } from "./domain/workflow.ts";
import { plain } from "./card.ts";
import { unitJudgment, type Observation } from "./domain/work-unit.ts";

export function widgetLines(
  s: State,
  width: number,
  error?: string,
  observation?: Observation,
): string[] {
  if (width < 1) return [];
  const line = (text: string) => truncateToWidth(plain(text).replace(/[\r\n\t]/g, " "), width);
  if (error) return [line("保存エラー · Mentor変更停止 · /mentor status")];
  if (!s.enabled) return [line("Mentor 一時停止 · /mentor で再開")];
  const i = activeIssue(s),
    u = activeUnit(s);
  let phases: [string, string, string, string];
  if (s.whole === "implementation")
    phases = {
      scope: ["範囲の相談", "範囲確認・実装開始", "範囲", "開始"],
      implementing: ["実装・検証", "結果の検討", "実装", "検討"],
      examination: ["結果の検討", "受け入れ確認", "検討", "受入"],
      judgment:
        u && unitJudgment(u, observation)?.decision === "accept"
          ? ["結果の判断", "全体の見直し", "判断", "全体"]
          : ["結果の判断", "結果の再検討", "判断", "再検討"],
    }[u?.phase ?? "scope"] as [string, string, string, string];
  else if (s.whole === "explore")
    phases = {
      hypothesis: ["案の相談", "批判・弁護", "案", "批判"],
      critique: ["批判・弁護", "方向の相談", "批判", "採否"],
      judgment: ["方向の相談", "採用確認・範囲", "採否", "範囲"],
    }[i?.inner ?? "hypothesis"] as [string, string, string, string];
  else
    phases = {
      goals: ["目標・制約の相談", "論点の整理", "目標", "論点"],
      issues: ["論点の整理", "案の相談", "論点", "案"],
      consistency: ["全体の見直し", "まとめ", "全体", "まとめ"],
      summary: ["まとめ", "終了の確認", "まとめ", "終了"],
    }[s.whole] as [string, string, string, string];
  const [current, next, shortCurrent, shortNext] = phases;
  const alert = s.whole === "implementation" && !observation?.source ? "鮮度不明 · " : "";
  const full = `${alert}Mentor · ${current} → ${next}`;
  const compact = `${alert}${shortCurrent} → ${shortNext}`;
  return [line(visibleWidth(full) <= width ? full : compact)];
}
