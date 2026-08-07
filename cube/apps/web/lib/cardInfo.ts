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
    if (t & 0x80000000) kinds.push('融合');
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
    parts.push(`LINK-${(c.type >> 24) & 0xff || 1}`);
  } else {
    const lv = c.level > 0 ? c.level : 0;
    if (t & 0x800000) parts.push(`RANK ${lv}`);
    else if (lv) parts.push(`等级 ${lv}`);
  }
  if (t & 0x1000000) parts.push(`刻度 ${(c.type >> 24) & 0xff}-${(c.type >> 16) & 0xff}`);
  return parts.join(' ');
}

export function atkDefLine(c: CardInfo): string {
  if (!(c.type & MONSTER)) return '';
  const atk = c.atk < 0 ? '?' : c.atk;
  const def = c.def < 0 ? '?' : c.def;
  return `攻击力 ${atk} / 守备力 ${def}`;
}

export function raceAttrLine(c: CardInfo): string {
  if (!(c.type & MONSTER)) return '';
  const race = RACE_NAMES[c.race] ?? '';
  const attr = ATTRIBUTE_NAMES[c.attribute] ?? '';
  return [race, attr].filter(Boolean).join(' · ');
}
