import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { location, type State } from './domain.ts';
import type { Observation } from './units.ts';

export function widgetLines(s: State, width: number, error?: string, observation?: Observation): string[] {
  if (width < 1) return [];
  if (error) return wrapTextWithAnsi('Mentor 保存エラー · /mentor status（変更停止中）', width);
  const [phase, issue, judgment] = location(s, observation);
  const compact = `${issue} · ${judgment}`;
  return [
    ...wrapTextWithAnsi(phase, width),
    ...(visibleWidth(compact) <= width ? [compact] : [truncateToWidth(issue, width), ...wrapTextWithAnsi(judgment, width)]),
  ];
}
