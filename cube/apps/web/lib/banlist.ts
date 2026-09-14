export interface Banlist { id: number; name: string; limits: Record<number, number> }
export function latestOcg(lists: Banlist[]): number {
  return lists.filter(l => /\bOCG\b/i.test(l.name)).sort((a, b) => b.name.localeCompare(a.name))[0]?.id ?? -1;
}
export function cardLimit(list: Banlist | undefined, card: { code: number; alias?: number }): number {
  return list?.limits?.[card.alias || card.code] ?? 3;
}
