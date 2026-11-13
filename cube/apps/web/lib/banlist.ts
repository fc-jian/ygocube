export type { DuelBanlist as Banlist } from '@ygocube/shared';
import type { DuelBanlist as Banlist } from '@ygocube/shared';

export function banlistChoices(lists: readonly Banlist[], selectedId?: number): Banlist[] {
  const choices: Banlist[] = [];
  const positions = new Map<string, number>();
  for (const list of lists) {
    const limits = Object.entries(list.limits).sort(([a], [b]) => Number(a) - Number(b));
    const key = JSON.stringify([list.name, list.format, list.effectiveDate, limits]);
    const position = positions.get(key);
    if (position === undefined) {
      positions.set(key, choices.length);
      choices.push(list);
    } else if (list.id === selectedId) {
      // Keep the selected native index even when another copy was loaded first.
      choices[position] = list;
    }
  }
  return choices;
}

export function latestOcg(lists: Banlist[], today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })): number {
  const date = (list: Banlist) => list.effectiveDate ?? list.name.slice(0, 10).replaceAll('.', '-');
  return lists.filter(l => (l.format ? l.format === 'OCG' : /\bOCG\b/i.test(l.name)) && date(l) <= today)
    .sort((a, b) => date(b).localeCompare(date(a)))[0]?.id ?? -1;
}
export function cardLimit(list: Banlist | undefined, card: { code: number; alias?: number }): number {
  return list?.limits?.[card.alias || card.code] ?? 3;
}
