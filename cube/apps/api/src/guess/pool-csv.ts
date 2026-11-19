import { CARD_ATTRIBUTES, CARD_LINK_DIRECTIONS, CARD_RACES, CARD_SUBTYPES, type CardSubtype } from '@ygocube/shared';
import { CardsService, compileSubtypeMatcher, isExtraDeckType } from '../cards/cards.service';

const subtypes = Object.entries(CARD_SUBTYPES).map(([key, value]) => ({ label: value[2], matches: compileSubtypeMatcher(key as CardSubtype) }));
const labels = (value: number, entries: readonly (readonly [number, string, ...string[]])[]) =>
  entries.filter(([bit]) => (value & bit) !== 0).map(([, label]) => label).join(' | ');

function cell(value: string | number): string {
  let text = String(value);
  if (typeof value === 'string' && /^\s*[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function guessPoolCsv(cards: CardsService, codes: readonly number[]): string {
  const rows: (string | number)[][] = [[
    '卡片编号', '卡名（显示）', '卡名（SC）', '卡名（NWBBS）', '卡名（日文）', '卡名（英文）', '效果文本', '字段', '字段编号',
    '卡片大类', '所属卡组', '子类型', '种族', '属性', '等级／阶级／连接值', '等级', '阶级', '连接值',
    '攻击力', '守备力', '攻击力筛选值', '守备力筛选值', '灵摆左刻度', '灵摆右刻度', '发售年份',
    '连接标记', '连接标记数', '连接标记位值', '类型位值', '种族位值', '属性位值', '别名编号', '别名类型',
  ]];
  for (const card of cards.getMany([...codes].sort((a, b) => a - b))) {
    const names = cards.localizedNames(card.code);
    const monster = (card.type & 1) !== 0;
    const link = monster && (card.type & 0x4000000) !== 0;
    const xyz = monster && !link && (card.type & 0x800000) !== 0;
    const pendulum = monster && (card.type & 0x1000000) !== 0;
    rows.push([
      String(card.code).padStart(8, '0'), card.name, names.sc, names.nw, names.jp, names.en, card.desc,
      card.setNames.join(' | '), card.setCodes.map((code) => `0x${code.toString(16).toUpperCase()}`).join(' | '),
      monster ? '怪兽' : card.type & 2 ? '魔法' : card.type & 4 ? '陷阱' : '',
      monster ? isExtraDeckType(card.type) ? '额外卡组' : '主卡组' : '主卡组',
      subtypes.filter(({ matches }) => matches(card.type)).map(({ label }) => label).join(' | '),
      monster ? labels(card.race, CARD_RACES) : '', monster ? labels(card.attribute, CARD_ATTRIBUTES) : '',
      monster ? card.level : '', monster && !link && !xyz ? card.level : '', xyz ? card.level : '', link ? card.level : '',
      monster ? card.atk < 0 ? '?' : card.atk : '', monster && !link ? card.def < 0 ? '?' : card.def : '',
      monster ? Math.max(0, card.atk) : '', monster && !link ? Math.max(0, card.def) : '',
      pendulum ? card.lscale : '', pendulum ? card.rscale : '', card.releaseYear ?? '',
      link ? labels(card.linkMarkers, CARD_LINK_DIRECTIONS) : '',
      link ? CARD_LINK_DIRECTIONS.filter(([bit]) => (card.linkMarkers & bit) !== 0).length : '',
      link ? card.linkMarkers : '', card.type, monster ? card.race : '', monster ? card.attribute : '',
      card.alias ? String(card.alias).padStart(8, '0') : '', card.aliasKind === 'artwork' ? '异画' : card.aliasKind === 'rule' ? '规则同名' : '',
    ]);
  }
  return '\uFEFF' + rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
