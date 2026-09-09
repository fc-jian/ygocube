"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { CardImage } from "@/components/CardImage";
import {
  readDecks,
  saveDeck,
  deleteDeck,
  parseYdk,
  ydk,
  SavedDeck,
} from "./deck-cookie";
import type { BrowserDeck } from "@ygocube/shared";
import { races, attributes } from "./duel-text";
import { LocalPicsSetting } from "@/components/IdentityWidget";
import "./standalone.css";
type Info = {
  code: number;
  name: string;
  desc: string;
  type: number;
  atk?: number;
  def?: number;
  level?: number;
  race?: number;
  attribute?: number;
};
const blank = (): BrowserDeck => ({
  name: "新卡组",
  main: [],
  extra: [],
  side: [],
});
const isExtra = (c: Info) =>
  !!(c.type & (0x40 | 0x2000 | 0x800000 | 0x4000000));
export function StandaloneDecks() {
  const [saved, setSaved] = useState<SavedDeck[]>([]),
    [deck, setDeck] = useState<BrowserDeck>(blank),
    [id, setId] = useState<string | undefined>(),
    [dirty, setDirty] = useState(false),
    [q, setQ] = useState(""),
    [results, setResults] = useState<Info[]>([]),
    [infos, setInfos] = useState<Record<number, Info>>({}),
    [detail, setDetail] = useState<Info | null>(null),
    [target, setTarget] = useState<"main" | "side">("main"),
    [notice, setNotice] = useState("");
  const [selectedCard, setSelectedCard] = useState<string | null>(null);
  const [drag, setDrag] = useState<{
    code: number;
    zone?: "main" | "extra" | "side";
    index?: number;
  } | null>(null);
  const [kind, setKind] = useState(0),
    [sort, setSort] = useState("relevance");
  useEffect(() => {
    setSaved(readDecks());
  }, []);
  useEffect(() => {
    const f = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", f);
    return () => window.removeEventListener("beforeunload", f);
  }, [dirty]);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      if (!q.trim()) {
        setResults([]);
        return;
      }
      api<Info[]>(`/public/duel/search?q=${encodeURIComponent(q)}`, {
        identity: null,
      })
        .then((r) => {
          if (active) {
            setResults(r);
            setInfos((v) => ({
              ...v,
              ...Object.fromEntries(r.map((c) => [c.code, c])),
            }));
          }
        })
        .catch((e) => active && setNotice(e.message));
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [q]);
  useEffect(() => {
    let active = true;
    const missing = [
      ...new Set([...deck.main, ...deck.extra, ...deck.side]),
    ].filter((c) => !infos[c]);
    if (!missing.length) return;
    Promise.all(
      Array.from({ length: Math.ceil(missing.length / 256) }, (_, i) =>
        api<Info[]>("/public/duel/cards", {
          method: "POST",
          identity: null,
          body: { codes: missing.slice(i * 256, (i + 1) * 256) },
        }),
      ),
    )
      .then((rows) => {
        if (active)
          setInfos((v) => ({
            ...v,
            ...Object.fromEntries(rows.flat().map((c) => [c.code, c])),
          }));
      })
      .catch((e) => active && setNotice(e.message));
    return () => {
      active = false;
    };
  }, [deck]);
  const edit = (d: BrowserDeck) => {
    setSelectedCard(null);
    setDeck(d);
    setDirty(true);
    setNotice("");
  };
  const replace = () => !dirty || window.confirm("放弃未保存修改？");
  const persist = (asNew = false) => {
    try {
      setId(saveDeck(deck, asNew ? undefined : id));
      setSaved(readDecks());
      setDirty(false);
      setNotice("已保存");
    } catch (e) {
      setNotice((e as Error).message);
    }
  };
  function add(c: Info) {
    const z = target === "side" ? "side" : isExtra(c) ? "extra" : "main";
    if (deck[z].length >= 200) {
      setNotice("区域已满");
      return;
    }
    edit({ ...deck, [z]: [...deck[z], c.code] });
  }
  function move(z: "main" | "extra" | "side", i: number) {
    const code = deck[z][i],
      c = infos[code];
    if (!c) return;
    const to = z === "side" ? (isExtra(c) ? "extra" : "main") : "side";
    if (deck[to].length >= 200) return;
    edit({
      ...deck,
      [z]: deck[z].filter((_, n) => n !== i),
      [to]: [...deck[to], code],
    });
  }

  const preview = detail && (infos[detail.code] ?? detail);
  const show = (code: number) =>
    setDetail(infos[code] ?? { code, name: String(code), desc: "", type: 0 });
  const summary = (c: Info) =>
    [
      c.type & 1 ? "怪兽" : c.type & 2 ? "魔法" : "陷阱",
      c.attribute ? attributes.zh[Math.log2(c.attribute)] : "",
      c.race ? races.zh[Math.log2(c.race)] : "",
      c.level ? `★${c.level}` : "",
    ]
      .filter(Boolean)
      .join(" / ");
  const filtered = results
    .filter((c) => !kind || !!(c.type & kind))
    .slice()
    .sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name, "zh")
        : sort === "attack"
          ? (b.atk ?? -1) - (a.atk ?? -1)
          : sort === "level"
            ? (b.level ?? 0) - (a.level ?? 0)
            : 0,
    );
  const drop = (zone: "main" | "extra" | "side") => {
    if (!drag) return;
    const c = infos[drag.code];
    if (!c) return;
    if (zone === "extra" && !isExtra(c)) {
      setNotice("这张卡不能加入额外卡组");
      setDrag(null);
      return;
    }
    const to = zone === "main" && isExtra(c) ? "extra" : zone;
    if (to === drag.zone) {
      setDrag(null);
      return;
    }
    if (deck[to].length >= 200) {
      setNotice("区域已满");
      setDrag(null);
      return;
    }
    const next = { ...deck };
    if (drag.zone !== undefined)
      next[drag.zone] = deck[drag.zone].filter((_, i) => i !== drag.index);
    next[to] = [...next[to], drag.code];
    edit(next);
    setDrag(null);
    setSelectedCard(null);
  };
  return (
    <main className="standalone builder deck-editor">
      <header className="deck-editor-header">
        <a href="/duel">← 对战大厅</a>
        <h1>卡组构筑</h1>
        <details className="deck-image-settings">
          <summary>卡图设置</summary>
          <LocalPicsSetting />
        </details>
      </header>
      <section className="deck-management" aria-label="卡组管理">
        <select
          aria-label="已保存卡组"
          value={id ?? ""}
          onChange={(e) => {
            if (!replace()) return;
            const d = saved.find((d) => d.id === e.target.value);
            if (d) {
              setDeck(d);
              setId(d.id);
              setDirty(false);
              setSelectedCard(null);
            }
          }}
        >
          <option value="">选择卡组</option>
          {saved.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} ({d.main.length}/{d.extra.length}/{d.side.length})
            </option>
          ))}
        </select>
        <input
          aria-label="卡组名称"
          maxLength={60}
          value={deck.name}
          onChange={(e) => edit({ ...deck, name: e.target.value })}
        />
        <button className="primary" onClick={() => persist()}>
          保存{dirty ? "*" : ""}
        </button>
        <button onClick={() => persist(true)}>另存</button>
        <button
          onClick={() => {
            if (replace()) {
              setDeck(blank());
              setId(undefined);
              setDirty(false);
              setSelectedCard(null);
            }
          }}
        >
          新建
        </button>
        <label className="deck-import">
          导入
          <input
            type="file"
            accept=".ydk,.txt"
            onChange={async (e) => {
              try {
                const f = e.target.files?.[0];
                if (!f || !replace()) return;
                if (f.size > 65536) throw Error("文件过大");
                const d = parseYdk(
                    await f.text(),
                    f.name.replace(/\.ydk$/i, ""),
                  ),
                  newId = saveDeck(d);
                setDeck(d);
                setId(newId);
                setDirty(false);
                setSaved(readDecks());
                setSelectedCard(null);
                setNotice("已导入并保存");
              } catch (e) {
                setNotice((e as Error).message);
              } finally {
                e.target.value = "";
              }
            }}
          />
        </label>
        <button
          onClick={() => {
            const url = URL.createObjectURL(
                new Blob([ydk(deck)], { type: "text/plain" }),
              ),
              a = document.createElement("a");
            a.href = url;
            a.download = deck.name + ".ydk";
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          导出
        </button>
        <button
          disabled={!id}
          onClick={() => {
            if (id && window.confirm("删除这副已保存卡组？")) {
              deleteDeck(id);
              setSaved(readDecks());
              setId(undefined);
              setDirty(true);
            }
          }}
        >
          删除
        </button>
        <button
          onClick={() =>
            edit({
              ...deck,
              ...Object.fromEntries(
                (["main", "extra", "side"] as const).map((z) => [
                  z,
                  [...deck[z]].sort(
                    (a, b) =>
                      (infos[a]?.type ?? 0) - (infos[b]?.type ?? 0) ||
                      (infos[b]?.level ?? 0) - (infos[a]?.level ?? 0) ||
                      a - b,
                  ),
                ]),
              ),
            })
          }
        >
          排序
        </button>
        <button
          onClick={() => {
            if (window.confirm("清空当前卡组？"))
              edit({ ...deck, main: [], extra: [], side: [] });
          }}
        >
          清空
        </button>
      </section>
      <div className="deck-workspace">
        <aside className="deck-inspector" aria-label="卡片详情">
          {preview ? (
            <>
              <CardImage
                code={preview.code}
                name={preview.name}
                className="deck-inspector-image"
              />
              <div className="deck-inspector-copy">
                <h2>{preview.name}</h2>
                <small>{preview.code}</small>
                <p className="deck-card-stats">
                  {summary(preview)}
                  {!!(preview.type & 1) && (
                    <>
                      <br />
                      {preview.atk ?? "?"} / {preview.def ?? "?"}
                    </>
                  )}
                </p>
                <p className="deck-effect-text">{preview.desc}</p>
              </div>
            </>
          ) : (
            <div className="deck-empty-preview">卡片详情</div>
          )}
        </aside>
        <section className="deck-zones" aria-label="当前卡组">
          <nav className="deck-zone-tabs" aria-label="卡组区域">
            {(["main", "extra", "side"] as const).map((z) => (
              <button
                key={z}
                onClick={() =>
                  document
                    .getElementById(`editor-zone-${z}`)
                    ?.scrollIntoView({ block: "start", behavior: "smooth" })
                }
              >
                {{ main: "主", extra: "额外", side: "副" }[z]} {deck[z].length}
              </button>
            ))}
          </nav>
          {(["main", "extra", "side"] as const).map((z) => (
            <section
              className={`deck-region deck-region-${z} ${drag ? "drop-ready" : ""}`}
              id={`editor-zone-${z}`}
              data-deck-zone={z}
              key={z}
              onDragOver={(e) => {
                if (drag) e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                drop(z);
              }}
            >
              <h2>
                {{ main: "主卡组", extra: "额外卡组", side: "副卡组" }[z]}{" "}
                <b>{deck[z].length}</b>
              </h2>
              <div className="builder-zone">
                {deck[z].map((code, i) => (
                  <article
                    key={`${code}-${i}`}
                    className={selectedCard === `${z}:${i}` ? "selected" : ""}
                    onMouseEnter={() => show(code)}
                    draggable={!!infos[code]}
                    onDragStart={(e) => {
                      setDrag({ code, zone: z, index: i });
                      e.dataTransfer.setData("text/plain", String(code));
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={() => setDrag(null)}
                  >
                    <button
                      className="card-preview"
                      aria-label={infos[code]?.name ?? String(code)}
                      aria-pressed={selectedCard === `${z}:${i}`}
                      onFocus={() => show(code)}
                      onClick={() => {
                        show(code);
                        setSelectedCard(`${z}:${i}`);
                      }}
                      onDoubleClick={() => move(z, i)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        edit({
                          ...deck,
                          [z]: deck[z].filter((_, n) => n !== i),
                        });
                        setSelectedCard(null);
                      }}
                    >
                      <CardImage
                        code={code}
                        name={infos[code]?.name ?? String(code)}
                      />
                    </button>
                    <div className="deck-card-controls">
                      <button
                        aria-label={`移到 ${z === "side" ? "主卡组／额外卡组" : "备选卡组"} ${i + 1}`}
                        onClick={() => {
                          move(z, i);
                          setSelectedCard(null);
                        }}
                      >
                        {z === "side" ? "移回卡组" : "移到副卡组"}
                      </button>
                      <button
                        aria-label={`删除 ${z} ${i + 1}`}
                        onClick={() => {
                          edit({
                            ...deck,
                            [z]: deck[z].filter((_, n) => n !== i),
                          });
                          setSelectedCard(null);
                        }}
                      >
                        移除
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </section>
        <section className="deck-search" aria-label="卡片搜索与结果">
          <input
            aria-label="搜索卡片"
            placeholder="卡名、效果、卡号"
            maxLength={100}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="deck-search-options">
            <select
              aria-label="筛选搜索结果"
              value={kind}
              onChange={(e) => setKind(+e.target.value)}
            >
              <option value={0}>全部种类</option>
              <option value={1}>怪兽</option>
              <option value={2}>魔法</option>
              <option value={4}>陷阱</option>
            </select>
            <select
              aria-label="结果排序"
              value={sort}
              onChange={(e) => setSort(e.target.value)}
            >
              <option value="relevance">相关度</option>
              <option value="level">星数 ↓</option>
              <option value="attack">攻击力 ↓</option>
              <option value="name">卡名</option>
            </select>
          </div>
          <label className="deck-search-target">
            添加到
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value as "main" | "side")}
            >
              <option value="main">主卡组／额外卡组</option>
              <option value="side">副卡组</option>
            </select>
          </label>
          <h2>
            搜索结果 <b>{filtered.length}</b>
            {results.length === 100 && <small>（前 100 张）</small>}
          </h2>
          <div className="builder-results">
            {filtered.map((c) => (
              <article
                key={c.code}
                onMouseEnter={() => setDetail(c)}
                draggable
                onDragStart={(e) => {
                  setDrag({ code: c.code });
                  e.dataTransfer.setData("text/plain", String(c.code));
                  e.dataTransfer.effectAllowed = "copy";
                }}
                onDragEnd={() => setDrag(null)}
              >
                <button
                  className="card-preview"
                  onFocus={() => setDetail(c)}
                  onClick={() => setDetail(c)}
                  onDoubleClick={() => add(c)}
                >
                  <CardImage code={c.code} name={c.name} />
                </button>
                <div className="deck-result-copy">
                  <strong>{c.name}</strong>
                  <small>{summary(c)}</small>
                  {!!(c.type & 1) && (
                    <span>
                      {c.atk ?? "?"} / {c.def ?? "?"}
                    </span>
                  )}
                  <button aria-label={`添加 ${c.name}`} onClick={() => add(c)}>
                    ＋{" "}
                    {target === "side"
                      ? "副卡组"
                      : isExtra(c)
                        ? "额外卡组"
                        : "主卡组"}
                  </button>
                </div>
              </article>
            ))}
            {q.trim() && !filtered.length && <p>没有匹配的卡片</p>}
          </div>
        </section>
      </div>
      <footer className="deck-editor-footer">
        <span role="status">{notice || (dirty ? "有未保存修改" : "")}</span>
        <span>双击移卡 · 右键移除 · 拖动调整区域</span>
      </footer>
    </main>
  );
}
