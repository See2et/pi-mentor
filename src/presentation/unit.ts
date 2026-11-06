import {
  KINDS,
  UNIT_DECISIONS,
  evidenceFreshness,
  sameSource,
  unitJudgmentStatus,
  unitRevision,
  type Observation,
  type Unit,
} from "../domain/work-unit.ts";

export function contractText(
  u: Pick<Unit, "id" | "revisions"> & Partial<Pick<Unit, "currentRevision">>,
  revision = u.currentRevision,
): string {
  const r = u.revisions.find((r) => r.revision === revision);
  if (!r) return `単位 U${u.id}: 確認済み契約なし`;
  const c = r.contract;
  return `U${u.id} / 契約 v${r.revision} [${r.author}; ${r.confirmed ? "本人確認済み" : "未確認"}]\n${KINDS[c.kind]}: ${c.title}\n目的: ${c.purpose}\n設計参照:\n${c.designRefs.join("\n")}\nスコープ:\n${c.scope}\n期待:\n${c.expectations.map((e) => `${e.id}: ${e.text}`).join("\n")}\n非目標:\n${c.nonGoals}\n検証計画（期待とは別）:\n${c.verificationPlan}`;
}
export function unitDetails(u: Unit, o?: Observation): string {
  const binding =
    unitRevision(u)
      ?.contract.expectations.map((x) => {
        const refs = u.evidence.filter(
          (e) =>
            e.revision === u.currentRevision &&
            sameSource(e.source, o?.source) &&
            e.entries.some((entry) => entry.expectationId === x.id),
        );
        return `${x.id}: ${refs.length ? refs.map((e) => `証拠 #${e.id}`).join(", ") + "（観測を読む。充足判定ではない）" : "現契約・最終観測ソースに紐づく証拠なし／不明"}`;
      })
      .join("\n") ?? "確認済み期待なし";
  return `${contractText(u)}\n\n${evidenceFreshness(u, o)}\n${unitJudgmentStatus(u, o)}\n現在ソース: ${o?.source ? JSON.stringify(o.source) : (o?.error ?? "不明")}\n観測範囲: Git追跡対象＋非ignored未追跡ファイルの内容・削除・実行属性。ignored / 外部サービス / 依存環境は対象外。最終確認時の一致でありライブ監視・隔離ではありません。\n\n現在の期待と証拠の対応（採点なし）:\n${binding}\n\n証拠（履歴。テスト成功は充足判定ではありません）:\n${u.evidence.map((e) => `証拠 #${e.id} / 契約 v${e.revision} / ${JSON.stringify(e.source)}\n${e.entries.map((x) => `${x.expectationId} [${x.method}] ${x.observation}\n参照・コマンド・結果: ${x.references.join("\n")}\n限界・未知: ${x.limitations}`).join("\n")}\n懸念: ${e.concerns}`).join("\n\n") || "未提出（未検証の期待あり）"}\n\nAI報告（準備完了は本人判断ではありません）:\n${u.reports.map((x) => `v${x.revision}: ${x.text}`).join("\n") || "なし"}\n\n質問・学習メモ（任意・採点なし）:\n${u.notes.map((x) => `v${x.revision} [${x.author}]: ${x.text}`).join("\n") || "なし"}\n\n本人判断履歴（別契約・ソースへ継承しません）:\n${u.judgments.map((j) => `v${j.revision} / ${JSON.stringify(j.source)} ${j.sourceError}\n証拠参照: ${j.evidenceIds.join(", ")}\n${UNIT_DECISIONS[j.decision]}: ${j.note}`).join("\n") || "未判断"}\n\n証拠のない期待・未知の懸念があっても、本人が留保を記録して判断できます。実験の受け入れは設計・機能の採用ではありません。`;
}
