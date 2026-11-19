import { api } from "@/lib/api";
import { parseYdk } from "./deck-cookie";
export async function importYdk(text: string, name: string) {
  const deck = parseYdk(text, name);
  const codes = [...new Set([...deck.main, ...deck.extra])];
  const types = new Map<number, number>();
  for (let i = 0; i < codes.length; i += 256) {
    const cards = await api<{ code: number; type: number }[]>(
      "/public/duel/cards",
      {
        method: "POST",
        identity: null,
        body: { codes: codes.slice(i, i + 256) },
      },
    );
    cards.forEach((c) => types.set(c.code, c.type));
  }
  const all = [...deck.main, ...deck.extra];
  const extra = (code: number) =>
    !!((types.get(code) ?? 0) & (0x40 | 0x2000 | 0x800000 | 0x4000000));
  return {
    ...deck,
    main: all.filter((c) => !extra(c)),
    extra: all.filter(extra),
  };
}
