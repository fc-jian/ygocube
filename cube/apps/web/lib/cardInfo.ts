import { CardInfo } from '@/lib/types';

// 卡牌类型/属性展示（与 ygopro 客户端信息一致，dev_docs/06 §5.1）
const MONSTER = 0x1;
const SPELL = 0x2;
const TRAP = 0x4;

// TYPES_EXTRA_DECK（融合 0x40 | 同调 0x2000 | XYZ 0x800000 | 连接 0x4000000）
export function isExtraDeckType(type: number): boolean {
  return (type & 0x4802040) !== 0;
}

// 注意：本仓库 mycard/ygopro（ocgcore/common.h）的 race 位序与 KONAMI 官方不同（整体重排：战士=0x1、龙=0x2000、幻龙=0x800000、电子界=0x1000000），
// cards.cdb 数据与该枚举配套，勿改成 KONAMI 官方位掩码。
const RACE_NAMES: Record<number, string> = {
  0x1: '战士族', 0x2: '魔法师族', 0x4: '天使族', 0x8: '恶魔族', 0x10: '不死族',
  0x20: '机械族', 0x40: '水族', 0x80: '炎族', 0x100: '岩石族', 0x200: '鸟兽族',
  0x400: '植物族', 0x800: '昆虫族', 0x1000: '雷族', 0x2000: '龙族', 0x4000: '兽族',
  0x8000: '兽战士族', 0x10000: '恐龙族', 0x20000: '鱼族', 0x40000: '海龙族', 0x80000: '爬虫类族',
  0x100000: '念动力族', 0x200000: '幻神兽族', 0x400000: '创造神族', 0x800000: '幻龙族',
  0x1000000: '电子界族', 0x2000000: '幻想魔族',
};

const ATTRIBUTE_NAMES: Record<number, string> = {
  0x1: '地', 0x2: '水', 0x4: '炎', 0x8: '风', 0x10: '光', 0x20: '暗', 0x40: '神',
};

export function typeLabel(c: CardInfo): string {
  const t = c.type;
  const kinds: string[] = [];
  if (t & MONSTER) {
    if (t & 0x40) kinds.push('融合');
    if (t & 0x2000) kinds.push('同调');
    if (t & 0x800000) kinds.push('XYZ');
    if (t & 0x4000000) kinds.push('连接');
    if (t & 0x1000000) kinds.push('灵摆');
    if (t & 0x1000) kinds.push('调整');
    if (t & 0x200000) kinds.push('反转');
    if (t & 0x10) kinds.push('通常');
    if (t & 0x20) kinds.push('效果');
    kinds.push('怪兽');
  } else if (t & SPELL) {
    if (t & 0x10000) kinds.push('速攻');
    else if (t & 0x20000) kinds.push('永续');
    else if (t & 0x40000) kinds.push('装备');
    else if (t & 0x80000) kinds.push('场地');
    if (t & 0x100000) kinds.push('仪式');
    kinds.push('魔法');
  } else if (t & TRAP) {
    if (t & 0x20000) kinds.push('永续');
    else if (t & 0x100000) kinds.push('反击');
    kinds.push('陷阱');
  }
  return kinds.join('·') || '未知';
}

export function statLine(c: CardInfo): string {
  const t = c.type;
  if (!(t & MONSTER)) return '';
  const parts: string[] = [];
  if (t & 0x4000000) {
    parts.push(`LINK-${c.level > 0 ? c.level : '?'}`);
  } else {
    const lv = c.level > 0 ? c.level : 0;
    if (t & 0x800000) parts.push(`RANK ${lv}`);
    else if (lv) parts.push(`等级 ${lv}`);
  }
  if (t & 0x1000000) parts.push(`刻度 ${c.lscale ?? 0}/${c.rscale ?? 0}`);
  return parts.join(' ');
}

export function atkDefLine(c: CardInfo): string {
  if (!(c.type & MONSTER)) return '';
  const atk = c.atk < 0 ? '?' : c.atk;
  if (c.type & 0x4000000) return `攻击力 ${atk} / 守备力 -`;
  const def = c.def < 0 ? '?' : c.def;
  return `攻击力 ${atk} / 守备力 ${def}`;
}

export function linkMarkerLine(c: CardInfo): string {
  if (!(c.type & 0x4000000)) return '';
  const labels: [number, string][] = [
    [0x40, '↖'], [0x80, '↑'], [0x100, '↗'], [0x8, '←'], [0x20, '→'], [0x1, '↙'], [0x2, '↓'], [0x4, '↘'],
  ];
  const arrows = labels.filter(([bit]) => ((c.linkMarkers ?? 0) & bit) !== 0).map(([, label]) => `[${label}]`).join('');
  return arrows ? `连接标记 ${arrows}` : '';
}

export function setNameLine(c: CardInfo): string {
  return c.setNames?.length ? `系列：${c.setNames.join('|')}` : '';
}

export function raceAttrLine(c: CardInfo): string {
  if (!(c.type & MONSTER)) return '';
  const race = RACE_NAMES[c.race] ?? '';
  const attr = ATTRIBUTE_NAMES[c.attribute] ?? '';
  return [race, attr].filter(Boolean).join(' · ');
}

export function matchesCardQuery(c: CardInfo | undefined, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (!c) return false;
  return [
    c.name, c.code, String(c.code).padStart(8, '0'), c.desc, typeLabel(c),
    raceAttrLine(c), statLine(c), atkDefLine(c), linkMarkerLine(c), setNameLine(c),
  ].join(' ').toLowerCase().includes(q);
}

// ---------- 排序（与 ygopro 客户端 DataManager::deck_sort_* 完全一致，dev_docs/06 §5.1） ----------

export type SortMode = 'lv' | 'atk' | 'def' | 'name' | 'id';

const EXTRA_MASK = 0x48020c0; // 融合|同调|XYZ|连接（附加类型分组用）
const EXTRA_GROUP_MASK = 0x48020c1;
const NORMAL_EFFECT_MASK = 0x31; // 怪兽|通常|效果

function typeGroup(c: CardInfo): number {
  // (type & 0x48020c0) ? (type & 0x48020c1) : (type & 0x31) —— 与 C++ 逐位一致
  return c.type & EXTRA_MASK ? c.type & EXTRA_GROUP_MASK : c.type & NORMAL_EFFECT_MASK;
}

// 主/额外/副区域内排序：与 ygopro 客户端一致——lv/atk/def 先按类型大类分组；
// name/id 是纯名称/编号排序（C++ deck_sort_name/deck_sort_id 不做分组）
export function sortCards(cards: CardInfo[], mode: SortMode): CardInfo[] {
  const indexed = cards.map((card, index) => ({ card, index }));
  const compare = (a: CardInfo, b: CardInfo): number => {
    if (mode === 'name') {
      const na = a.name ?? '';
      const nb = b.name ?? '';
      if (na !== nb) return na < nb ? -1 : 1;
      return a.code - b.code;
    }
    if (mode === 'id') return a.code - b.code;
    const cat = (c: CardInfo) => c.type & 0x7;
    const ca = cat(a);
    const cb = cat(b);
    if (ca !== cb) return ca - cb;
    if (ca === 1) {
      if (mode === 'atk') {
        if (a.atk !== b.atk) return b.atk - a.atk;
        if (a.def !== b.def) return b.def - a.def;
        if (a.level !== b.level) return b.level - a.level;
        const ta = typeGroup(a);
        const tb = typeGroup(b);
        if (ta !== tb) return ta - tb;
        return a.code - b.code;
      }
      if (mode === 'def') {
        if (a.def !== b.def) return b.def - a.def;
        if (a.atk !== b.atk) return b.atk - a.atk;
        if (a.level !== b.level) return b.level - a.level;
        const ta = typeGroup(a);
        const tb = typeGroup(b);
        if (ta !== tb) return ta - tb;
        return a.code - b.code;
      }
      // lv（默认）：附加类型 → 等级降 → 攻降 → 守降 → 编号
      const ta = typeGroup(a);
      const tb = typeGroup(b);
      if (ta !== tb) return ta - tb;
      if (a.level !== b.level) return b.level - a.level;
      if (a.atk !== b.atk) return b.atk - a.atk;
      if (a.def !== b.def) return b.def - a.def;
      return a.code - b.code;
    }
    // 魔法/陷阱：type&0xfffffff8 分组 → 编号（lv/atk/def 同策略）
    if ((a.type & 0xfffffff8) !== (b.type & 0xfffffff8)) return (a.type & 0xfffffff8) - (b.type & 0xfffffff8);
    return a.code - b.code;
  };
  indexed.sort((a, b) => compare(a.card, b.card) || a.index - b.index);
  return indexed.map((x) => x.card);
}

// Metadata failures must never make a card disappear. Known cards use the ygopro comparator;
// unknown cards remain visible after known cards and retain their original order.
export function sortCardCodes(codes: number[], cardMap: Record<number, CardInfo>, mode: SortMode): number[] {
  const rows = codes.map((code, index) => ({ code, index, card: cardMap[code] }));
  const known = sortCards(rows.filter((x) => !!x.card).map((x) => x.card!), mode);
  const rank = new Map<number, number>();
  known.forEach((c, i) => {
    if (!rank.has(c.code)) rank.set(c.code, i);
  });
  return [...rows].sort((a, b) => {
    if (!!a.card !== !!b.card) return a.card ? -1 : 1;
    if (!a.card || !b.card) return a.index - b.index;
    const ai = rank.get(a.code) ?? a.index;
    const bi = rank.get(b.code) ?? b.index;
    return ai - bi || a.index - b.index;
  }).map((x) => x.code);
}
