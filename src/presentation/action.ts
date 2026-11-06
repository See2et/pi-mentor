import { ok, safeTry } from "neverthrow";
import {
  concerns,
  currentJudgment,
  currentRevision,
  issueById,
  newerDraft,
} from "../domain/design.ts";
import type { Outcome } from "../domain/errors.ts";
import { discussionView, focusedRevision, type State } from "../domain/state.ts";
import {
  evidenceFreshness,
  unitById,
  unitJudgment,
  unitRevision,
  type Observation,
} from "../domain/work-unit.ts";
import type { Edge, Next } from "../domain/workflow-schema.ts";
import { activeIssue, activeUnit } from "../domain/workflow.ts";
import { contractText, unitDetails } from "./unit.ts";

export function workTitle(s: State): string {
  if (!s.enabled) return "Mentor 一時停止 · /mentor で再開";
  const i = activeIssue(s),
    u = activeUnit(s);
  if (s.whole === "implementation")
    return u
      ? `${unitRevision(u)?.contract.title ?? "実装範囲"}を${{ scope: "具体化する", implementing: "実装・確認する", examination: "結果から確かめる", judgment: "判断する" }[u.phase]}`
      : "実装・実験の範囲を具体化する（まだ開始しない）";
  if (s.whole === "explore" && i)
    return `${i.text}：${{ hypothesis: "自分の仮説を考える", critique: "批判・弁護する" }[discussionView(s).mode]}（相談対象 ${discussionView(s).targets.length}件）`;
  const wholeTitles: Partial<Record<State["whole"], string>> = {
    goals: "目標と制約を整理する",
    issues: "目標・次の論点を相談する",
    consistency: "全体のつながりを見直す",
    summary: "決定と残った課題をまとめる",
  };
  return wholeTitles[s.whole] ?? "現在の相談";
}
export function actionMeaning(e: Edge, s?: State): { label: string; effect: string } {
  switch (e.type) {
    case "goals":
      return {
        label: "この目標・制約で論点を考える",
        effect: "表示した目標と制約を記録し、論点を選ぶ相談へ進みます。",
      };
    case "issue":
      return {
        label: "この論点を相談の対象にする",
        effect:
          "表示した論点を相談の対象に加えます。モードや過去の判断は変えず、仮説の採用でもありません。",
      };
    case "hypothesis":
      return {
        label: "仮説形成に戻る（AIは方法を勧めない）",
        effect:
          "同じ相談の仮説形成モードに戻ります。対象・批判・判断の履歴を保持し、実装は許可しません。",
      };
    case "critique": {
      const issue = s && activeIssue(s);
      const changed =
        e.text !== undefined &&
        (!s ||
          !issue ||
          e.text !== focusedRevision(s)?.text ||
          e.text !== currentRevision(issue)?.text);
      return changed
        ? {
            label: "この修正案を検討対象にして批判・弁護する",
            effect:
              "表示した正確な修正案を現在の検討対象として確定し、批判・弁護へ移ります。以前の案・批判・判断は履歴に残ります。採用・実装許可・結果の受け入れではありません。",
          }
        : {
            label: "現在の案を変えずに批判・弁護する",
            effect:
              "現在の検討対象を変更せず、批判・弁護へ移ります。新しい下書きは適用しません。採用・実装許可・結果の受け入れではありません。",
          };
    }
    case "decide":
      return {
        label: "この案の採否を考える",
        effect: "同じ案と懸念をもとに方向を決める相談へ進みます。まだ採用しません。",
      };
    case "adopt":
      return {
        label: "この方向を暫定採用し、範囲を考える",
        effect:
          "表示した正確な現在の案を本人確認し、暫定採用として記録します。実装は許可しません。次に範囲を具体化します。",
      };
    case "revise":
      return {
        label: "この案を練り直す",
        effect: "修正する判断を記録し、案を考える相談へ戻ります。過去の案・批判は残します。",
      };
    case "scope":
      return {
        label:
          e.contract.kind === "experiment" ? "この実験の範囲を検討する" : "この実装範囲を検討する",
        effect:
          "表示した範囲・期待・検証計画を記録します。まだ実装・実験を開始せず、設計の採用も変えません。",
      };
    case "start":
      return {
        label: "この範囲で実装・検証を始める",
        effect:
          "表示した正確な範囲・期待・非目標・検証計画を確定し、この単位だけの実装・検証を明示的に許可します。",
      };
    case "inspect":
      return {
        label: "この結果を確かめる",
        effect:
          "実装を止め、表示した契約・観測・証拠・限界を照合する相談へ進みます。受け入れではありません。",
      };
    case "accept":
      return {
        label: "この結果を留保込みで受け入れる",
        effect:
          "表示した契約・最終観測ソース・証拠・不足と留保に紐づく受け入れを記録し、目標や次の論点の相談に戻ります。次の実装は開始しません。実験の受入は設計・機能採用ではありません。",
      };
    case "correct":
      return {
        label: "この範囲の修正を始める",
        effect:
          "修正依頼を記録し、表示した現契約の範囲だけの実装・検証を再び明示的に許可します。範囲を変えるなら先に設計へ戻ってください。",
      };
    case "design":
      return {
        label: "実装を止めて設計に戻る",
        effect: "設計に戻る判断を記録し、案を考える相談に戻ります。実装は再開しません。",
      };
    case "defer":
      return {
        label: "この検討を保留する",
        effect: "現在の対象に保留を記録して、論点を選ぶ相談へ戻ります。他の作業は開始しません。",
      };
    case "review":
      return {
        label: "全体のつながりを見直す",
        effect:
          "全体の目標・各判断・残った課題を照合する相談へ進みます。採否や受け入れは変えません。",
      };
    case "finish":
      return {
        label: "ここまでを区切り、通常チャットへ戻る",
        effect:
          "まとめの位置でMentorを一時停止します。未解決事項の解決・採用・受け入れを意味しません。履歴は残ります。",
      };
    case "revisitGoals":
      return {
        label: "目標と制約を見直す",
        effect: "目標と制約の相談に戻ります。実装の開始・再開は許可しません。",
      };
    case "switchIssue":
      return {
        label: "この論点の相談に戻る",
        effect: "表示した論点の、最後に選んだ検討内容に戻ります。判断は変更しません。",
      };
    case "switchUnit":
      return {
        label: "この作業の相談に戻る",
        effect:
          "表示した単位の相談に戻ります。実装中だった単位も範囲の確認に戻し、実装を自動再開しません。",
      };
  }
}
export function operationFeedback(
  before: State,
  after: State,
  p: Next,
  status: "planned" | "applied" = "applied",
): string {
  const label = actionMeaning(p.edge, before).label;
  const i = activeIssue(after),
    selected = focusedRevision(after),
    old = focusedRevision(before);
  const target =
    p.edge.type === "critique" && i
      ? `検討対象: r${old?.revision ?? "—"} → r${selected?.revision ?? "—"}（${old?.revision === selected?.revision ? "内容変更なし" : "表示した正確な修正案を適用"}）\n${selected?.text ?? "まだなし"}\n${status === "applied" ? "採用・実装許可・結果の受け入れは記録していません。過去の批判・判断は保持しました。" : "採用・実装許可・結果の受け入れは記録しません。過去の批判・判断は保持します。"}\n`
      : "";
  return `${status === "applied" ? "適用しました" : "承認すると"}: ${label}\n${target}${status === "applied" ? "現在の相談" : "承認後の相談"}: ${workTitle(after)}`;
}
export function exactArtifact(s: State, p: Next, o?: Observation): Outcome<string> {
  return safeTry(function* () {
    const e = p.edge,
      i = activeIssue(s),
      u = activeUnit(s);
    let artifact = "";
    if (e.type === "goals") artifact = `目標:\n${e.goal}\n\n制約:\n${e.constraints || "なし"}`;
    else if (e.type === "issue") artifact = `検討する論点:\n${e.text}`;
    else if (e.type === "scope" || (e.type === "start" && e.contract)) {
      const c = e.contract!;
      artifact = `種類: ${c.kind === "experiment" ? "仮説実験（設計採用ではない）" : "機能実装"}\n題名: ${c.title}\n目的: ${c.purpose}\n設計参照:\n${c.designRefs.join("\n")}\n範囲:\n${c.scope}\n期待:\n${c.expectations.map((x) => `${x.id}: ${x.text}`).join("\n")}\n非目標:\n${c.nonGoals}\n検証計画:\n${c.verificationPlan}`;
    } else if (e.type === "switchIssue") {
      const target = yield* issueById(s, e.issueId);
      artifact = `論点: ${target.text}\n案:\n${currentRevision(target)?.text ?? "まだなし"}\n現在の判断: ${currentJudgment(target)?.decision ?? "未判断"}`;
    } else if (e.type === "switchUnit") artifact = unitDetails(yield* unitById(s, e.unitId), o);
    else if (s.whole === "implementation" && u)
      artifact = e.type === "start" ? contractText(u) : unitDetails(u, o);
    else if (i && s.whole === "explore") {
      const changed =
        e.type === "critique" && e.text !== undefined && e.text !== focusedRevision(s)?.text;
      const focused = focusedRevision(s);
      const saved =
        e.type === "critique" && e.text !== undefined
          ? currentRevision(i)?.text === e.text
            ? currentRevision(i)
            : newerDraft(i, e.text)
          : focused;
      const discussion = (revision: number | null) =>
        `未撤回の懸念（根拠・条件付き）:\n${
          concerns(i, revision)
            .map((c) => `[${c.category}] ${c.text}\n${c.evidence}`)
            .join("\n\n") || "記録なし（正しさの保証ではありません）"
        }\n\n弁護・応答:\n${
          i.responses
            .filter((r) => r.revision === revision)
            .map((r) => `[${r.author}] ${r.text}`)
            .join("\n\n") || "記録なし"
        }`;
      artifact = `論点: ${i.text}\n\n検討対象の正確な案:\n${e.type === "critique" && e.text !== undefined ? e.text : (focused?.text ?? "まだなし")}\n\n今回の検討対象への記録:\n${saved ? discussion(saved.revision) : "まだ記録なし（正しさの保証ではありません）"}${changed ? `\n\n以前の案への記録（今回の案へ自動継承しません。履歴は保持）:\n${discussion(focused?.revision ?? null)}` : ""}`;
    } else
      artifact = `目標: ${s.goal || "未設定"}\n制約: ${s.constraints || "未設定"}\n\n${s.issues
        .map(
          (i) =>
            `${i.text}\n案: ${currentRevision(i)?.text ?? "なし"}\n判断: ${currentJudgment(i)?.decision ?? "未判断"}\n残った懸念: ${
              concerns(i)
                .map((c) => c.text)
                .join(" / ") || "記録なし"
            }`,
        )
        .join(
          "\n\n",
        )}\n\n${s.units.map((u) => `${unitRevision(u)?.contract.title ?? "未確認の範囲"}: ${unitJudgment(u, o)?.decision ?? "現在の受け入れなし"} / ${evidenceFreshness(u, o)}`).join("\n")}`;
    const origin =
      e.type === "critique" && i
        ? `変更前の検討対象 r${discussionView(s).focus?.revision ?? "—"}:\n${focusedRevision(s)?.text ?? "まだなし"}\n\n`
        : "";
    const targets =
      e.type === "hypothesis" || e.type === "critique"
        ? `同じ相談に保持する対象（モードは相談全体で共有）:\n${discussionView(s)
            .targets.map((t) => `#${t.issueId} r${t.revision ?? "—"}`)
            .join(" / ")}\n\n`
        : "";
    return ok(
      `${origin}${targets}${p.summary}\n\n未解決・留保:\n${p.unresolved || "追加の記載なし（解決済みの保証ではありません）"}\n\n${artifact}${"note" in e ? `\n\n今回記録する理由・留保（AI整理、選択により本人判断）:\n${e.note || "追記なし"}` : ""}`,
    );
  });
}
