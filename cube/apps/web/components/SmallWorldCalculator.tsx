'use client';

import { useMemo, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { CardWithTooltip } from './CardImage';
import type {
  CardInfo,
  SmallWorldCalculationResponse,
  SmallWorldPath,
  SmallWorldSharedProperty,
} from '@ygocube/shared';

type SortMode = 'hand' | 'bridge' | 'target';

const PROPERTY_LABELS: Record<SmallWorldSharedProperty, string> = {
  race: '种族',
  attribute: '属性',
  level: '星级',
  atk: '攻击力',
  def: '防御力',
};

const SORT_LABELS: Record<SortMode, string> = {
  hand: '手牌怪兽',
  bridge: '中间怪兽',
  target: '检索目标',
};

function parseCodes(text: string): { codes: number[]; invalid: string[] } {
  const tokens = text.normalize('NFKC').split(/[\s,，、;；]+/u).filter(Boolean);
  const codes: number[] = [];
  const invalid: string[] = [];
  for (const token of tokens) {
    if (!/^\d+$/u.test(token)) {
      invalid.push(token);
      continue;
    }
    const code = Number(token);
    if (!Number.isSafeInteger(code) || code <= 0) invalid.push(token);
    else codes.push(code);
  }
  return { codes, invalid };
}

function cardName(card: CardInfo | undefined, code: number): string {
  return card?.name || String(code);
}

function pathCode(path: SmallWorldPath, mode: SortMode): number {
  if (mode === 'hand') return path.handCode;
  if (mode === 'bridge') return path.bridgeCode;
  return path.targetCode;
}

function pathRoles(path: SmallWorldPath, mode: SortMode): number[] {
  const selected = pathCode(path, mode);
  const rest = mode === 'hand'
    ? [path.bridgeCode, path.targetCode]
    : mode === 'bridge'
      ? [path.handCode, path.targetCode]
      : [path.handCode, path.bridgeCode];
  return [selected, ...rest];
}

function isDeckMonster(card: CardInfo): boolean {
  // Keep this in sync with the Small World eligibility check in the API:
  // monsters from the Extra Deck are not valid hand/bridge/target choices.
  return (card.type & 0x1) !== 0 && (card.type & 0x4802040) === 0;
}

function PathCard({ label, code, card }: { label: string; code: number; card?: CardInfo }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center gap-1">
      <span className="text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-emerald-200/65">{label}</span>
      {card ? (
        <CardWithTooltip code={code} card={card} className="h-28 w-20 max-w-full sm:h-36 sm:w-24" />
      ) : (
        <div className="flex h-28 w-20 items-center justify-center rounded-md border border-slate-600/70 bg-slate-900 p-2 text-center text-xs text-slate-400 sm:h-36 sm:w-24">
          {code}
        </div>
      )}
      <div className="w-full min-w-0 text-center">
        <p className="truncate text-sm font-semibold text-slate-100" title={cardName(card, code)}>{cardName(card, code)}</p>
        <p className="font-mono text-[0.65rem] text-slate-500">{code}</p>
      </div>
    </div>
  );
}

function SharedBadge({ property }: { property: SmallWorldSharedProperty }) {
  return (
    <span className="rounded-full border border-gold/35 bg-gold/10 px-2 py-1 text-[0.65rem] font-semibold text-gold-soft">
      {PROPERTY_LABELS[property]}
    </span>
  );
}

function PathRow({ path, cards }: { path: SmallWorldPath; cards: Map<number, CardInfo> }) {
  return (
    <article className="rounded-xl border border-felt-edge/80 bg-felt-deep/65 p-2.5 shadow-[0_12px_30px_rgba(0,0,0,0.16)] sm:p-3">
      <div className="flex items-center justify-center gap-1 pb-2 text-[0.65rem] text-slate-400">
        <span className="rounded bg-emerald-950/80 px-1.5 py-0.5">手牌→中间</span>
        <SharedBadge property={path.handBridgeShared} />
        <span className="text-emerald-200/45">·</span>
        <span className="rounded bg-emerald-950/80 px-1.5 py-0.5">中间→目标</span>
        <SharedBadge property={path.bridgeTargetShared} />
      </div>
      <div className="flex items-start gap-1 sm:gap-2">
        <PathCard label="手牌怪兽" code={path.handCode} card={cards.get(path.handCode)} />
        <div className="flex shrink-0 pt-16 text-lg text-gold/75 sm:pt-20">→</div>
        <PathCard label="中间怪兽" code={path.bridgeCode} card={cards.get(path.bridgeCode)} />
        <div className="flex shrink-0 pt-16 text-lg text-gold/75 sm:pt-20">→</div>
        <PathCard label="检索目标" code={path.targetCode} card={cards.get(path.targetCode)} />
      </div>
    </article>
  );
}

export function SmallWorldCalculator() {
  const [deckText, setDeckText] = useState('');
  const [handText, setHandText] = useState('');
  const [allowSameHandTarget, setAllowSameHandTarget] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>('hand');
  const [handFilter, setHandFilter] = useState<number | ''>('');
  const [targetFilter, setTargetFilter] = useState<number | ''>('');
  const [result, setResult] = useState<SmallWorldCalculationResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cards = useMemo(() => {
    const map = new Map<number, CardInfo>();
    for (const card of result?.cards ?? []) map.set(card.code, card);
    return map;
  }, [result]);

  const sortedPaths = useMemo(() => {
    if (!result) return [];
    const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
    return [...result.paths].sort((a, b) => {
      for (const [aCode, bCode] of pathRoles(a, sortMode).map((code, index) => [code, pathRoles(b, sortMode)[index]] as const)) {
        const nameCompare = collator.compare(cardName(cards.get(aCode), aCode), cardName(cards.get(bCode), bCode));
        if (nameCompare !== 0) return nameCompare;
        if (aCode !== bCode) return aCode - bCode;
      }
      return 0;
    });
  }, [cards, result, sortMode]);

  const filterCards = useMemo(() => {
    if (!result) return [];
    const deckCodes = new Set(parseCodes(deckText).codes);
    const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
    return [...cards.values()]
      .filter((card) => deckCodes.has(card.code) && isDeckMonster(card))
      .sort((a, b) => collator.compare(a.name, b.name) || a.code - b.code);
  }, [cards, deckText, result]);

  const filteredPaths = useMemo(() => sortedPaths.filter((path) => (
    (handFilter === '' || path.handCode === handFilter)
      && (targetFilter === '' || path.targetCode === targetFilter)
  )), [handFilter, sortedPaths, targetFilter]);

  async function calculate() {
    const deck = parseCodes(deckText);
    const hand = parseCodes(handText);
    const invalid = [...deck.invalid, ...hand.invalid];
    if (invalid.length > 0) {
      setError(`无法识别的 code：${invalid.join('、')}`);
      setResult(null);
      return;
    }
    if (deck.codes.length === 0) {
      setError('请输入主卡组的 code list。');
      setResult(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const next = await api<SmallWorldCalculationResponse>('/tools/small-world/calculate', {
        method: 'POST',
        body: {
          deckCodes: deck.codes,
          handCodes: hand.codes,
          allowSameHandTarget,
        },
        identity: null,
      });
      setResult(next);
      setHandFilter('');
      setTargetFilter('');
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'BAD_SMALL_WORLD_INPUT') {
        setError('输入的 code list 无效，请检查格式和数量。');
      } else {
        setError('计算失败，请稍后重试。');
      }
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto min-h-screen max-w-7xl px-4 py-6 sm:px-8 sm:py-10">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="yc-kicker mb-3">Yu-Gi-Oh! Utility · Small World</p>
          <h1 className="yc-title text-4xl font-black tracking-tight sm:text-5xl">小世界现象检索计算器</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-400">
            输入主卡组和可选手牌的卡片 code，枚举所有“手牌怪兽 → 中间怪兽 → 检索目标”的合法路径；手牌留空时自动扫描主卡组全部候选怪兽。
          </p>
        </div>
        <a href="/" className="yc-secondary px-4 py-2 text-xs font-semibold">返回 YGO Cube</a>
      </div>

      <section className="yc-panel p-4 sm:p-6">
        <div className="grid gap-4 lg:grid-cols-2">
          <label className="block">
            <span className="mb-2 block text-sm font-semibold text-emerald-100">卡组 code list</span>
            <textarea
              value={deckText}
              onChange={(event) => setDeckText(event.target.value)}
              className="min-h-44 w-full resize-y rounded-lg bg-felt-deep px-3 py-3 font-mono text-sm leading-6 text-slate-100 outline-none"
              placeholder="例如：89631139 14558127\n支持空格、逗号和换行"
              spellCheck={false}
            />
          </label>
          <label className="block">
            <span className="mb-2 block text-sm font-semibold text-emerald-100">手牌 code list（可选）</span>
            <textarea
              value={handText}
              onChange={(event) => setHandText(event.target.value)}
              className="min-h-44 w-full resize-y rounded-lg bg-felt-deep px-3 py-3 font-mono text-sm leading-6 text-slate-100 outline-none"
              placeholder="可留空：留空时扫描主卡组全部 unique 怪兽"
              spellCheck={false}
            />
          </label>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button onClick={() => void calculate()} disabled={loading} className="yc-primary px-5 py-2.5 text-sm font-bold disabled:cursor-wait disabled:opacity-60">
            {loading ? '计算中…' : '计算检索路径'}
          </button>
          <button
            onClick={() => {
              setDeckText('');
              setHandText('');
              setAllowSameHandTarget(false);
              setHandFilter('');
              setTargetFilter('');
              setResult(null);
              setError(null);
            }}
            className="yc-secondary px-5 py-2.5 text-sm font-semibold"
          >
            清空
          </button>
          <span className="text-xs text-slate-500">手牌留空时按实际副本扫描全部主卡组怪兽；额外卡和非怪兽卡会自动跳过。</span>
        </div>
        <label className="mt-3 flex items-start gap-2 text-xs text-slate-400">
          <input
            type="checkbox"
            checked={allowSameHandTarget}
            onChange={(event) => setAllowSameHandTarget(event.target.checked)}
            className="mt-0.5 accent-emerald-400"
          />
          <span>
            允许同一张卡同时作为手牌和检索目标
            <span className="ml-1 text-slate-500">（默认按精确 code 排除）</span>
          </span>
        </label>
        {error && <p className="yc-notice mt-4 px-4 py-3 text-sm">{error}</p>}
        {result?.unknownCodes.length ? (
          <p className="yc-notice mt-4 px-4 py-3 text-sm">未找到的 code：{result.unknownCodes.join('、')}</p>
        ) : null}
      </section>

      {result && (
        <section className="mt-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="yc-kicker">Results</p>
              <h2 className="mt-1 text-xl font-bold text-emerald-50">
                {handFilter !== '' || targetFilter !== ''
                  ? `显示 ${filteredPaths.length} / ${result.summary.pathCount} 条合法路径`
                  : `共 ${result.summary.pathCount} 条合法路径`}
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                {result.summary.handMode === 'deck_unique' ? '已扫描主卡组全部 unique 怪兽' : '指定手牌模式'} · 有效主卡组怪兽 {result.summary.eligibleDeckCount} 张 · 有效候选手牌怪兽 {result.summary.eligibleHandCount} 张
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-slate-300">
              <label className="flex items-center gap-1.5">
                手牌：
                <select
                  aria-label="按手牌怪兽筛选"
                  value={handFilter}
                  onChange={(event) => setHandFilter(event.target.value ? Number(event.target.value) : '')}
                  className="max-w-44 rounded-lg bg-felt-deep px-2.5 py-2 text-xs text-slate-100 outline-none"
                >
                  <option value="">全部手牌怪兽</option>
                  {filterCards.map((card) => <option key={card.code} value={card.code}>{card.name} ({card.code})</option>)}
                </select>
              </label>
              <label className="flex items-center gap-1.5">
                目标：
                <select
                  aria-label="按检索目标筛选"
                  value={targetFilter}
                  onChange={(event) => setTargetFilter(event.target.value ? Number(event.target.value) : '')}
                  className="max-w-44 rounded-lg bg-felt-deep px-2.5 py-2 text-xs text-slate-100 outline-none"
                >
                  <option value="">全部检索目标</option>
                  {filterCards.map((card) => <option key={card.code} value={card.code}>{card.name} ({card.code})</option>)}
                </select>
              </label>
              <label className="flex items-center gap-1.5">
                排序：
                <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)} className="rounded-lg bg-felt-deep px-2.5 py-2 text-xs text-slate-100 outline-none">
                  {(Object.keys(SORT_LABELS) as SortMode[]).map((mode) => <option key={mode} value={mode}>{SORT_LABELS[mode]}</option>)}
                </select>
              </label>
            </div>
          </div>

          {filteredPaths.length > 0 ? (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {filteredPaths.map((path) => <PathRow key={`${path.handCode}-${path.bridgeCode}-${path.targetCode}`} path={path} cards={cards} />)}
              <p className="col-span-full pt-1 text-center text-xs text-slate-500">已展示全部 {filteredPaths.length} 条路径</p>
            </div>
          ) : (
            <div className="yc-panel px-6 py-12 text-center">
              <p className="text-lg font-semibold text-slate-200">没有找到合法检索路径</p>
              <p className="mt-2 text-sm text-slate-500">请确认手牌与主卡组怪兽之间存在恰好一项共同属性。</p>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
