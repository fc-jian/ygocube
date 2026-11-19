export const edisonText = {
  zh: {
    title: 'Edison 三轮轮抽',
    seats: '2–9 人，开局随机排座，三轮座位固定。',
    outer: '第一、三轮顺时针，每包 20 张主卡，每手选 1 张。',
    middle: '第二轮逆时针，每包 20 张主卡加 15 张额外卡。超过 5 人时额外卡按人数平均分包，每包最多 15 张，余数留在池外。',
    pick: '每手选 1 张主卡和 1 张额外卡，额外卡选完后继续单选主卡。',
    deck: '构筑只使用亲自抓到的份数，三区合计同名最多 3 张。',
    main: '主卡', extra: '额外卡', choose: '待选', confirm: '确认两张并传包',
    clockwise: '顺时针', counterclockwise: '逆时针',
  },
  en: {
    title: 'Edison three-round draft',
    seats: '2–9 players. Seats are randomized once at the start.',
    outer: 'Rounds 1 and 3 pass clockwise. Each pack has 20 Main Deck cards. Pick one per hand.',
    middle: 'Round 2 passes counterclockwise with 20 Main Deck and 15 Extra Deck cards per pack. With more than five players, divide the available Extra Deck cards evenly, up to 15 per pack. Set the remainder aside.',
    pick: 'Pick one Main Deck and one Extra Deck card together. Once the Extra Deck cards run out, pick one Main Deck card at a time.',
    deck: 'Use only the copies you drafted, up to three of the same name across all deck zones.',
    main: 'Main Deck', extra: 'Extra Deck', choose: 'Choose a card', confirm: 'Confirm both and pass',
    clockwise: 'Clockwise', counterclockwise: 'Counterclockwise',
  },
} as const;

export function EdisonDraftRules({ lang = 'zh' }: { lang?: keyof typeof edisonText }) {
  const text = edisonText[lang];
  return (
    <section className="col-span-full w-full rounded border border-gold/25 bg-felt-deep/45 px-3 py-2 text-sm">
      <h3 className="font-semibold text-gold">{text.title}</h3>
      <p className="mt-1">{text.seats} {text.outer}</p>
      <p>{text.middle} {text.pick}</p>
      <p className="text-slate-300">{text.deck}</p>
    </section>
  );
}
