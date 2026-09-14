import type { BrowserDeck } from "@ygocube/shared";

export type DeckZone = "main" | "extra" | "side";
export type DeckDrag = { code: number; zone?: DeckZone; index?: number };
export const isExtraType = (type: number) =>
  !!(type & (0x40 | 0x2000 | 0x800000 | 0x4000000));

// Index is the insertion boundary in the original destination, before removal.
export function insertDeckCard(
  deck: BrowserDeck,
  drag: DeckDrag,
  zone: DeckZone,
  type: number,
  index = deck[zone].length,
): BrowserDeck {
  if (zone === "extra" && !isExtraType(type)) return deck;
  const to = zone === "main" && isExtraType(type) ? "extra" : zone;
  if (
    drag.zone &&
    (drag.index === undefined || deck[drag.zone][drag.index] !== drag.code)
  )
    return deck;
  if (to !== drag.zone && deck[to].length >= 200) return deck;
  const next = {
    ...deck,
    main: [...deck.main],
    extra: [...deck.extra],
    side: [...deck.side],
  };
  let at = to === zone ? index : next[to].length;
  if (drag.zone && drag.index !== undefined) {
    next[drag.zone].splice(drag.index, 1);
    if (drag.zone === to && drag.index < at) at--;
  }
  next[to].splice(Math.max(0, Math.min(at, next[to].length)), 0, drag.code);
  return next;
}
