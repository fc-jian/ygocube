import type { Choice, DuelState, Prompt } from "@ygocube/duel-protocol";
export function sameCard(a: Choice["ref"], b: Choice["ref"]) {
  return (
    !!a &&
    !!b &&
    a.player === b.player &&
    a.location === b.location &&
    a.sequence === b.sequence &&
    (!(a.location & 128) || (a.sub ?? 0) === (b.sub ?? 0))
  );
}
export function cardActions(prompt: Prompt | null, card: Choice["ref"] | null) {
  if (!card) return [];
  return (prompt?.choices ?? []).filter((c) => sameCard(c.ref, card));
}
// YGOPro system strings use printf placeholders; do not render an unfilled template.
export function formatSystemText(
  template: string | undefined,
  args: (string | number)[],
  fallback = "",
) {
  if (!template) return fallback;
  let index = 0,
    missing = false;
  const formatted = template.replace(
    /%%|%(?:\d+\$)?[-+ #0]*\d*(?:\.\d+)?(?:ll|l|z)?[sdiu]/g,
    (token) => {
      if (token === "%%") return "%";
      const positional = token.match(/^%(\d+)\$/);
      const value = args[positional ? Number(positional[1]) - 1 : index++];
      if (value === undefined) {
        missing = true;
        return "";
      }
      return String(value);
    },
  );
  return missing || /%(?:\d+\$)?(?:ll|l)?[a-z]/i.test(formatted)
    ? fallback
    : formatted;
}
export function effectQuestion(
  prompt: Prompt,
  strings: Record<number, string>,
  name: (code: number) => string,
  location: (loc: number) => string,
) {
  const c = prompt.choices.find((c) => c.code),
    code = c?.code ?? 0,
    title = name(code);
  const fallback =
    prompt.message === 12 ? `是否发动「${title}」的效果？` : "是否确认？";
  if (prompt.message !== 12)
    return formatSystemText(strings[prompt.hint ?? 0], [], fallback);
  const id = prompt.hint || 200;
  const area = c?.ref ? location(c.ref.location & 127) : "场上";
  return formatSystemText(
    strings[id],
    id === 200 || id === 221 ? [area, title] : [title],
    fallback,
  );
}
export type DuelEffect = {
  kind: "activate" | "formed" | "resolve" | "solved" | "negated" | "end";
  index: number;
  code: number;
  ref?: Choice["ref"];
};
export function duelEffect(
  state: DuelState,
  frame: Uint8Array,
): DuelEffect | null {
  if (frame[2] !== 1) return null;
  const m = frame[3];
  const kinds: Record<number, DuelEffect["kind"]> = {
    70: "activate",
    71: "formed",
    72: "resolve",
    73: "solved",
    74: "end",
    75: "negated",
    76: "negated",
  };
  if (!kinds[m]) return null;
  const index =
    m === 70
      ? (state.chain[state.chain.length - 1]?.index ?? 0)
      : (frame[4] ?? 0);
  const c = state.chain.find((c) => c.index === index);
  return { kind: kinds[m], index, code: c?.code ?? 0, ref: c?.ref };
}

export function publicChoiceCode(
  choice: Choice,
  state: DuelState,
  own: number,
) {
  if (choice.code) return choice.code;
  const card = state.cards.find((card) => sameCard(choice.ref, card));
  if (!card?.code) return 0;
  return card.player === own ||
    card.location === 16 ||
    (!!(card.location & (4 | 8 | 32 | 64)) && !!(card.position & 5))
    ? card.code
    : 0;
}
export function chainMatches(
  link: Choice,
  card: Choice["ref"] & { code: number },
  state?: DuelState,
) {
  const sourceExists = state?.cards.some(
    (source) => sameCard(link.ref, source) && source.code === link.code,
  );
  return (
    sameCard(link.ref, card) ||
    (!sourceExists &&
      !!link.code &&
      link.code === card.code &&
      sameCard(link.originRef, card))
  );
}
