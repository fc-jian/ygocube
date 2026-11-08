export const CARD_ATTRIBUTES = [
  [0x1, '地', 'EARTH'], [0x2, '水', 'WATER'], [0x4, '炎', 'FIRE'], [0x8, '风', 'WIND'],
  [0x10, '光', 'LIGHT'], [0x20, '暗', 'DARK'], [0x40, '神', 'DIVINE'],
] as const;

// Match the race bits in this project's YGOPro cards.cdb.
export const CARD_RACES = [
  [0x1, '战士族', 'Warrior'], [0x2, '魔法师族', 'Spellcaster'], [0x4, '天使族', 'Fairy'],
  [0x8, '恶魔族', 'Fiend'], [0x10, '不死族', 'Zombie'], [0x20, '机械族', 'Machine'],
  [0x40, '水族', 'Aqua'], [0x80, '炎族', 'Pyro'], [0x100, '岩石族', 'Rock'],
  [0x200, '鸟兽族', 'Winged Beast'], [0x400, '植物族', 'Plant'], [0x800, '昆虫族', 'Insect'],
  [0x1000, '雷族', 'Thunder'], [0x2000, '龙族', 'Dragon'], [0x4000, '兽族', 'Beast'],
  [0x8000, '兽战士族', 'Beast-Warrior'], [0x10000, '恐龙族', 'Dinosaur'], [0x20000, '鱼族', 'Fish'],
  [0x40000, '海龙族', 'Sea Serpent'], [0x80000, '爬虫类族', 'Reptile'], [0x100000, '念动力族', 'Psychic'],
  [0x200000, '幻神兽族', 'Divine-Beast'], [0x400000, '创造神族', 'Creator God'], [0x800000, '幻龙族', 'Wyrm'],
  [0x1000000, '电子界族', 'Cyberse'], [0x2000000, '幻想魔族', 'Illusion'],
] as const;

export const CARD_LINK_DIRECTIONS = [
  [0x40, '↖', '左上', 'Up-left'], [0x80, '↑', '上', 'Up'], [0x100, '↗', '右上', 'Up-right'],
  [0x8, '←', '左', 'Left'], [0x20, '→', '右', 'Right'],
  [0x1, '↙', '左下', 'Down-left'], [0x2, '↓', '下', 'Down'], [0x4, '↘', '右下', 'Down-right'],
] as const;

export const CARD_SUBTYPES = {
  'normal-monster': [1, 0x10, '通常怪兽', 'Normal Monster'],
  'effect-monster': [1, 0x20, '效果怪兽', 'Effect Monster'],
  'ritual-monster': [1, 0x80, '仪式怪兽', 'Ritual Monster'],
  fusion: [1, 0x40, '融合', 'Fusion'],
  synchro: [1, 0x2000, '同调', 'Synchro'],
  xyz: [1, 0x800000, '超量', 'Xyz'],
  pendulum: [1, 0x1000000, '灵摆', 'Pendulum'],
  link: [1, 0x4000000, '连接', 'Link'],
  tuner: [1, 0x1000, '调整', 'Tuner'],
  flip: [1, 0x200000, '反转', 'Flip'],
  spirit: [1, 0x200, '灵魂', 'Spirit'],
  union: [1, 0x400, '同盟', 'Union'],
  gemini: [1, 0x800, '二重', 'Gemini'],
  toon: [1, 0x400000, '卡通', 'Toon'],
  'special-summon': [1, 0x2000000, '特殊召唤', 'Special Summon'],
  'normal-spell': [2, 0, '通常魔法', 'Normal Spell'],
  'quick-play': [2, 0x10000, '速攻魔法', 'Quick-Play Spell'],
  'continuous-spell': [2, 0x20000, '永续魔法', 'Continuous Spell'],
  equip: [2, 0x40000, '装备魔法', 'Equip Spell'],
  field: [2, 0x80000, '场地魔法', 'Field Spell'],
  'ritual-spell': [2, 0x80, '仪式魔法', 'Ritual Spell'],
  'normal-trap': [4, 0, '通常陷阱', 'Normal Trap'],
  'continuous-trap': [4, 0x20000, '永续陷阱', 'Continuous Trap'],
  counter: [4, 0x100000, '反击陷阱', 'Counter Trap'],
} as const;

export const CARD_RANGE_LIMITS = {
  level: [0, 255],
  atk: [0, 0x7fffffff],
  def: [0, 0x7fffffff],
  year: [1900, 9999],
  linkCount: [0, 8],
} as const;

export type CardRangeField = keyof typeof CARD_RANGE_LIMITS;
export type CardSearchRange = { min?: number; max?: number };
export type CardCategory = 1 | 2 | 4;
export type CardSubtype = keyof typeof CARD_SUBTYPES;
export type CardSearchSort = 'relevance' | 'level' | 'attack' | 'name';
export type CardSearchFilters = Partial<Record<CardRangeField, CardSearchRange>> & {
  category?: CardCategory;
  subtype?: CardSubtype;
  attributes?: number;
  races?: number;
  linkMarkers?: number;
};

export interface CardSearchParams {
  query: string;
  page: number;
  filters: CardSearchFilters;
  sort: CardSearchSort;
}

export function cardQueryTokens(query: string): string[] {
  const normalized = query.normalize('NFKC').toLowerCase();
  const tokens = Array.from(normalized.matchAll(/"([^"]*)"|[^\s"]+/gu), ([token, phrase]) => (phrase ?? token).trim());
  return [...new Set(tokens.filter(Boolean))];
}
