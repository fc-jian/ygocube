export type { DuelBanlist as Banlist } from '@ygocube/shared';
import type { DuelBanlist as Banlist } from '@ygocube/shared';

export function latestOcg(lists: Banlist[], today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })): number {
  const date = (list: Banlist) => list.effectiveDate ?? list.name.slice(0, 10).replaceAll('.', '-');
  return lists.filter(l => (l.format ? l.format === 'OCG' : /\bOCG\b/i.test(l.name)) && date(l) <= today)
    .sort((a, b) => date(b).localeCompare(date(a)))[0]?.id ?? -1;
}
export function cardLimit(list: Banlist | undefined, card: { code: number; alias?: number }): number {
  return list?.limits?.[card.alias || card.code] ?? 3;
}
