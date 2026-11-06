import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ok, safeTry } from "neverthrow";
import { actionCard } from "./card.ts";
import { reject, type Outcome } from "./domain/errors.ts";
import type { Next } from "./domain/workflow-schema.ts";
import { alternativeEdges, currentNext } from "./domain/workflow.ts";
import { hostAsync } from "./host.ts";
import { mentorMenu, type MenuOwner } from "./menu.ts";
import { selectMenu } from "./navigation.ts";
import { actionMeaning, exactArtifact, workTitle } from "./presentation/action.ts";
import { details } from "./presentation/record.ts";
import { inspect } from "./viewer.ts";

export interface GuidedOwner extends MenuOwner {
  edge(proposal: Next, token: string): Outcome<void>;
}
export async function guidedMenu(
  ctx: ExtensionCommandContext,
  owner: GuidedOwner,
): Promise<Outcome<void>> {
  return safeTry(async function* () {
    const before = owner.token();
    if (!ctx.isIdle()) {
      ctx.ui.notify("Mentor: 現在の応答の終了を待っています。", "info");
      yield* await hostAsync(() => ctx.waitForIdle());
      if (
        before.split("/").slice(0, 2).join("/") !== owner.token().split("/").slice(0, 2).join("/")
      )
        return reject("Session/branch changed while waiting. Open /mentor again.", "freshness");
    }
    const token = owner.token(),
      s = owner.state(),
      o = owner.observation();
    if (owner.error()) return await mentorMenu("", ctx, owner);
    const choose = async (title: string, entries: [string, string][]) => {
      const result = await hostAsync(() =>
        selectMenu(
          ctx,
          title,
          entries.map(([, label]) => label),
        ),
      );
      return result.andThen((value) =>
        owner.check(token).map(() => entries.find(([, label]) => value === label)?.[0]),
      );
    };
    if (!s.enabled) {
      const choice = yield* await choose(workTitle(s), [
        ["continue", "通常チャットを続ける"],
        ["resume", "Mentor を開始・再開"],
        ["history", "履歴を見る"],
      ]);
      if (choice === "resume") yield* owner.user({ type: "resume" }, token);
      else if (choice === "history") {
        yield* await hostAsync(() => inspect(ctx, "Mentor 全記録・履歴", details(s, o)));
        yield* owner.check(token);
      }
      return ok(undefined);
    }
    let proposal = currentNext(s, o);
    const organize = () =>
      owner.ask(
        "[Mentor: organize next action]\nContinue our discussion with a concrete question, then organize targets and unresolved matters. Formation: clarify the learner's own hypotheses, NEVER recommend methods/solutions. Critique: actively criticize and offer alternatives. mentor_discuss organizes multiple targets/related issues without changing mode. Propose reversible hypothesis/critique mode changes via mentor_next/mentor_assist and wait for explicit selection. When implementation is wanted, ONE exact-contract start approval directly from discussion suffices; adopt/scope are optional. This request itself never changes mode, adopts, authorizes implementation or accepts a result.",
      );
    for (;;) {
      const meaning = proposal && actionMeaning(proposal.edge, s);
      const body = proposal
        ? `次にすること: ${meaning!.label}\n選ぶと: ${meaning!.effect}\n\n候補（詳細はスクロール）:\n${yield* exactArtifact(s, proposal, o)}`
        : `ここでは普通のチャットで相談を続けます。\n${s.guided?.pending ? "前の候補は記録またはコードが変わったため使えません。整理し直してください。" : "仮説や関連する論点をこのまま相談できます。結果があるときは、目標に照らして次に考えたいことを話してください。相談を続けても実装は開始しません。"}\n\n「相談の続きを問いかけてもらう」は相談だけを始め、何も確定しません。ヒントや別の進み方は「その他…」から選べます。`;
      const selected = yield* await hostAsync(() =>
        actionCard(ctx, workTitle(s), body, meaning?.label ?? "相談の続きを問いかけてもらう"),
      );
      yield* owner.check(token);
      if (selected === "edge") {
        if (proposal) yield* owner.edge(proposal, token);
        else yield* organize();
        return ok(undefined);
      }
      if (selected !== "other") return ok(undefined);
      const alternatives = alternativeEdges(s, o);
      const options: [string, string][] = [
        ["back", "カードに戻る"],
        ["hint", "今回だけのヒントを依頼"],
        ["organize", "別の進み方を相談する（変更なし）"],
        ...("note" in (proposal?.edge ?? {})
          ? [["note", "今回記録する理由・留保を編集"] as [string, string]]
          : []),
        ...alternatives.map((e, n): [string, string] => [`alt:${n}`, actionMeaning(e, s).label]),
        ["topics", "別の論点・作業の相談に戻る…"],
        ["history", "全記録・履歴を見る"],
        ["pause", "Mentor を一時停止する"],
      ];
      const choice = yield* await choose("その他（選ぶまでは変更しません）", options);
      if (!choice) return ok(undefined);
      if (choice === "back") continue;
      if (choice === "hint") return await mentorMenu("hint", ctx, owner);
      if (choice === "organize") return organize();
      if (choice === "pause") {
        yield* owner.user({ type: "pause" }, token);
        return ok(undefined);
      }
      if (choice === "note" && proposal && "note" in proposal.edge) {
        const prefill = proposal.edge.note;
        const note = yield* await hostAsync(() =>
          ctx.ui.editor("今回の判断に残す理由・留保（Esc取消）", prefill),
        );
        yield* owner.check(token);
        if (note !== undefined) proposal = { ...proposal, edge: { ...proposal.edge, note } };
        continue;
      }
      if (choice === "history") {
        if (!(yield* await hostAsync(() => inspect(ctx, "Mentor 全記録・履歴", details(s, o))))) {
          yield* owner.check(token);
          return ok(undefined);
        }
        yield* owner.check(token);
        continue;
      }
      if (choice.startsWith("alt:")) {
        proposal = {
          summary: "進み方を変更します。",
          unresolved: "",
          edge: alternatives[Number(choice.slice(4))],
        };
        continue;
      }
      if (choice === "topics") {
        const entries: [string, string][] = [
          ["back", "カードに戻る"],
          ...s.issues.map((i) => [`i:${i.id}`, `論点 ${i.id}: ${i.text}`] as [string, string]),
          ...s.units.map(
            (u) =>
              [
                `u:${u.id}`,
                `作業 ${u.id}: ${u.revisions.find((r) => r.revision === u.currentRevision)?.contract.title ?? "未確認の範囲"}`,
              ] as [string, string],
          ),
        ];
        const target = yield* await choose("戻る相談を選ぶ（ここでは未確定）", entries);
        if (!target) return ok(undefined);
        if (target !== "back")
          proposal = {
            summary: "以前の相談を再開します。",
            unresolved: "",
            edge: target.startsWith("i:")
              ? { type: "switchIssue", issueId: Number(target.slice(2)) }
              : { type: "switchUnit", unitId: Number(target.slice(2)) },
          };
      }
    }
  });
}
