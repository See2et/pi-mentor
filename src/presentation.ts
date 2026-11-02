import { truncateToWidth } from '@earendil-works/pi-tui';
import type { State } from './domain.ts';
import { actionMeaning, activeIssue, activeUnit, currentNext, workTitle } from './guided.ts';
import { plain } from './card.ts';
import { currentRevision } from './domain.ts';
import { evidenceFreshness, unitJudgmentStatus, type Observation } from './units.ts';

export function widgetLines(s: State, width: number, error?: string, observation?: Observation): string[] {
  if (width < 1) return [];
  const line = (text: string) => truncateToWidth(plain(text).replace(/[\r\n\t]/g, ' '), width);
  if (error) return [line('Mentor 保存エラー · /mentor status（変更停止中）')];
  if (!s.enabled) return [line(workTitle(s))];
  const next = currentNext(s, observation), i = activeIssue(s), u = activeUnit(s);
  const candidate = next?.summary ?? (i && s.whole === 'explore' ? currentRevision(i)?.text : undefined);
  return [
    line(`Mentor · ${workTitle(s)}`),
    ...(candidate ? [line(`候補: ${candidate}`)] : []),
    ...(next?.unresolved ? [line(`未解決: ${next.unresolved}`)] : []),
    line(`次: ${next ? actionMeaning(next.edge, s).label : s.guided?.pending ? '候補を整理し直す（記録／コード変更）' : '会話から次の一手を整理する'} · /mentor`),
    ...(s.whole === 'implementation' && u ? [line(`${evidenceFreshness(u, observation)} · ${unitJudgmentStatus(u, observation)}`)] : []),
  ];
}
