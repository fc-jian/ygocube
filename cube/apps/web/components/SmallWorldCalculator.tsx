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

function PathCard({ label, code, card }: { label: string; code: number; card?: CardInfo }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center gap-2">
      <span className="text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-emerald-200/65">{label}</span>
      {card ? (
        <CardWithTooltip code={code} card={card} className="h-36 w-24 max-w-full sm:h-44 sm:w-[7.4rem]" />
      ) : (
        <div className="flex h-36 w-24 items-center justify-center rounded-md border border-slate-600/70 bg-slate-900 p-2 text-center text-xs text-slate-400 sm:h-44 sm:w-[7.4rem]">
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
    <article className="rounded-xl border border-felt-edge/80 bg-felt-deep/65 p-3 shadow-[0_12px_30px_rgba(0,0,0,0.16)] sm:p-4">
      <div className="flex items-center justify-center gap-2 pb-3 text-[0.65rem] text-slate-400">
        <span className="rounded bg-emerald-950/80 px-2 py-1">手牌→中间</span>
        <SharedBadge property={path.handBridgeShared} />
        <span className="text-emerald-200/45">·</span>
        <span className="rounded bg-emerald-950/80 px-2 py-1">中间→目标</span>
        <SharedBadge property={path.bridgeTargetShared} />
      </div>
      <div className="flex items-start gap-2 sm:gap-5">
        <PathCard label="手牌怪兽" code={path.handCode} card={cards.get(path.handCode)} />
        <div className="flex shrink-0 pt-20 text-xl text-gold/75 sm:pt-24">→</div>
        <PathCard label="中间怪兽" code={path.bridgeCode} card={cards.get(path.bridgeCode)} />
        <div className="flex shrink-0 pt-20 text-xl text-gold/75 sm:pt-24">→</div>
        <PathCard label="检索目标" code={path.targetCode} card={cards.get(path.targetCode)} />
      </div>
    </article>
  );
}

export function SmallWorldCalculator() {
  const [deckText, setDeckText] = useState('');
  const [handText, setHandText] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('hand');
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
        body: { deckCodes: deck.codes, handCodes: hand.codes },
        identity: null,
      });
      setResult(next);
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
              setResult(null);
              setError(null);
            }}
            className="yc-secondary px-5 py-2.5 text-sm font-semibold"
          >
            清空
          </button>
          <span className="text-xs text-slate-500">手牌留空时按实际副本扫描全部主卡组怪兽；额外卡和非怪兽卡会自动跳过。</span>
        </div>
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
              <h2 className="mt-1 text-xl font-bold text-emerald-50">共 {result.summary.pathCount} 条合法路径</h2>
              <p className="mt-1 text-xs text-slate-500">
                {result.summary.handMode === 'deck_unique' ? '已扫描主卡组全部 unique 怪兽' : '指定手牌模式'} · 有效主卡组怪兽 {result.summary.eligibleDeckCount} 张 · 有效候选手牌怪兽 {result.summary.eligibleHandCount} 张
              </p>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-300">
              排序：
              <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)} className="rounded-lg bg-felt-deep px-3 py-2 text-sm text-slate-100 outline-none">
                {(Object.keys(SORT_LABELS) as SortMode[]).map((mode) => <option key={mode} value={mode}>{SORT_LABELS[mode]}</option>)}
              </select>
            </label>
          </div>

          {sortedPaths.length > 0 ? (
            <div className="space-y-3">
              {sortedPaths.map((path) => <PathRow key={`${path.handCode}-${path.bridgeCode}-${path.targetCode}`} path={path} cards={cards} />)}
              <p className="pt-2 text-center text-xs text-slate-500">已展示全部 {sortedPaths.length} 条路径</p>
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
