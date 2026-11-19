import type { BrowserDeck } from "@ygocube/shared";
export type SavedDeck = BrowserDeck & {
  id: string;
};
const prefix = "yc_dueldeck_";
export function parseYdk(text: string, name: string): BrowserDeck {
  const deck: BrowserDeck = { name, main: [], extra: [], side: [] };
  let zone: "main" | "extra" | "side" = "main";
  for (const line of text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((v) => v.trim())) {
    if (line === "#main") zone = "main";
    else if (line === "#extra") zone = "extra";
    else if (line === "!side") zone = "side";
    else if (line && !line.startsWith("#")) {
      if (!/^\d+$/.test(line) || +line <= 0 || +line > 0xffffffff)
        throw Error("\u65E0\u6548\u7684 YDK \u5361\u53F7");
      deck[zone].push(+line);
    }
  }
  if (deck.main.length + deck.extra.length + deck.side.length > 500)
    throw Error("\u5361\u7EC4\u8FC7\u5927");
  return deck;
}
export function ydk(d: BrowserDeck) {
  return ["#main", ...d.main, "#extra", ...d.extra, "!side", ...d.side].join(
    "\n",
  );
}
export function readDecks(): SavedDeck[] {
  return document.cookie
    .split("; ")
    .filter((v) => v.startsWith(prefix))
    .flatMap((v) => {
      try {
        const [key, value] = v.split("="),
          a = JSON.parse(decodeURIComponent(value));
        if (!Array.isArray(a) || a.length !== 4 || typeof a[0] !== "string" || a[0].length > 100 || !/^[a-f0-9]{32}$/.test(key.slice(prefix.length))) return [];
        const zones = a.slice(1).map((v: unknown) => {
          if (typeof v !== "string" || (v && !/^[a-z0-9]+(?:\.[a-z0-9]+)*$/.test(v))) throw Error("Invalid saved deck");
          const codes = v ? v.split(".").map(c => parseInt(c, 36)) : [];
          if (codes.length > 200 || codes.some(c => !Number.isInteger(c) || c <= 0 || c > 0xffffffff)) throw Error("Invalid saved deck");
          return codes;
        });
        if (zones.reduce((sum, zone) => sum + zone.length, 0) > 500) return [];
        return [
          {
            id: key.slice(prefix.length),
            name: a[0],
            ...Object.fromEntries(
              ["main", "extra", "side"].map((z, i) => [
                z,
                zones[i],
              ]),
            ),
          } as SavedDeck,
        ];
      } catch {
        return [];
      }
    });
}
export function saveDeck(
  d: BrowserDeck,
  id = crypto.randomUUID().replaceAll("-", ""),
) {
  if (
    !/^[a-f0-9]{32}$/.test(id) ||
    typeof d.name !== "string" ||
    d.name.length > 100 ||
    [d.main, d.extra, d.side].some(
      (zone) =>
        !Array.isArray(zone) ||
        zone.length > 200 ||
        zone.some((c) => !Number.isInteger(c) || c <= 0 || c > 0xffffffff),
    ) ||
    d.main.length + d.extra.length + d.side.length > 500
  )
    throw Error("\u5361\u7EC4\u683C\u5F0F\u6216\u6570\u91CF\u65E0\u6548");
  const value = encodeURIComponent(
    JSON.stringify([
      d.name,
      ...[d.main, d.extra, d.side].map((v) =>
        v.map((c) => c.toString(36)).join("."),
      ),
    ]),
  );
  const others = document.cookie
    .split("; ")
    .filter((v) => v.startsWith(prefix) && !v.startsWith(prefix + id + "="));
  if (
    value.length > 3000 ||
    others.length >= 8 ||
    others.join("; ").length + value.length > 7000
  )
    throw Error(
      "Cookie \u7A7A\u95F4\u4E0D\u8DB3\uFF0C\u8BF7\u5148\u5BFC\u51FA\u5E76\u5220\u9664\u65E7\u5361\u7EC4",
    );
  document.cookie = `${prefix}${id}=${value}; Path=/duel; Max-Age=31536000; SameSite=Strict${location.protocol === "https:" ? "; Secure" : ""}`;
  if (!document.cookie.split("; ").includes(`${prefix}${id}=${value}`))
    throw Error("\u6D4F\u89C8\u5668\u672A\u5141\u8BB8\u4FDD\u5B58 Cookie");
  return id;
}
export function deleteDeck(id: string) {
  document.cookie = `${prefix}${id}=; Path=/duel; Max-Age=0; SameSite=Strict`;
}
