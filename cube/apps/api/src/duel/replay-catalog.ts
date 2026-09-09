import crypto from "crypto";
import fs from "fs";
import zlib from "zlib";
import Database from "better-sqlite3";
import { config } from "../config";
import { getDb } from "../db";
import { CardsService, cardDatabasePaths } from "../cards/cards.service";
// One immutable catalog per process resource generation. Card updates restart the API.
let cache:
  | {
      key: string;
      id: string;
      payload: Buffer;
    }
  | undefined;
export function captureReplayCatalog(tid: number, mid: number) {
  const key = `${config.server.cardsCdb}:${config.server.cardNamesJson}:${config.server.stringsConf}`;
  if (!cache || cache.key !== key) {
    const cards = new CardsService();
    const metadata = cards.getMany(cards.allCodes());
    const descriptions: Record<number, string> = {};
    if (fs.existsSync(config.server.stringsConf))
      for (const line of fs
        .readFileSync(config.server.stringsConf, "utf8")
        .split(/\r?\n/)) {
        const m = line.match(/^!system\s+(\d+)\s+(.+)$/);
        if (m) descriptions[Number(m[1])] = m[2];
      }
    for (const file of cardDatabasePaths(config.server.cardsCdb)) {
      const source = new Database(file, { readonly: true });
      try {
        for (const row of source
          .prepare("SELECT * FROM texts")
          .iterate() as Iterable<Record<string, any>>)
          for (let i = 1; i <= 16; i++)
            if (row[`str${i}`]) descriptions[row.id * 16 + i - 1] = row[`str${i}`];
            else delete descriptions[row.id * 16 + i - 1];
      } finally {
        source.close();
      }
    }
    const payload = zlib.deflateSync(
      Buffer.from(JSON.stringify({ cards: metadata, descriptions })),
    );
    const id = crypto.createHash("sha256").update(payload).digest("hex");
    cache = { key, id, payload };
  }
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      "INSERT OR IGNORE INTO web_replay_catalogs(id,payload) VALUES(?,?)",
    ).run(cache!.id, cache!.payload);
    db.prepare(
      "INSERT OR IGNORE INTO web_replay_catalog_matches(tournament_id,match_id,catalog_id) VALUES(?,?,?)",
    ).run(tid, mid, cache!.id);
  })();
  return cache.id;
}
export function readReplayCatalog(
  tid: number,
  mid: number,
): {
  cards: any[];
  descriptions: Record<number, string>;
} | null {
  const row = getDb()
    .prepare(
      "SELECT payload FROM web_replay_catalogs c JOIN web_replay_catalog_matches m ON m.catalog_id=c.id WHERE m.tournament_id=? AND m.match_id=?",
    )
    .get(tid, mid) as
    | {
        payload: Buffer;
      }
    | undefined;
  return row
    ? JSON.parse(
        zlib
          .inflateSync(row.payload, { maxOutputLength: 128 * 1024 * 1024 })
          .toString(),
      )
    : null;
}
