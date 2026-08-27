'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { ConfirmModal } from '@/components/ConfirmModal';

interface PoolInfo {
  id: number;
  name: string;
  count: number;
  isDefault?: boolean;
  url?: string | null;
}

type MatchFormat = 'round_robin' | 'swiss' | 'double_elimination';
const recommendFormat = (n: number): { matchFormat: MatchFormat; swissRoundCount: number; playoffSize: number } =>
  n <= 2 ? { matchFormat: 'round_robin', swissRoundCount: 1, playoffSize: 0 }
    : n <= 8 ? { matchFormat: 'swiss', swissRoundCount: 3, playoffSize: 0 }
      : n <= 16 ? { matchFormat: 'swiss', swissRoundCount: 4, playoffSize: 4 }
        : { matchFormat: 'swiss', swissRoundCount: Math.ceil(Math.log2(n)) + 1, playoffSize: 8 };

function readableCreateError(error: any): string {
  const details = error?.details;
  if (details && typeof details === 'object' && typeof details.message === 'string') return details.message;
  const messages: Record<string, string> = {
    AUTH_REQUIRED: '请输入权限用户名和创建 token（超级管理员可只填写超级 token）',
    BAD_PAYLOAD: '请检查比赛名称、人数、牌堆和卡组限制等字段',
    BAD_EXTRA_RATIO: '额外卡比例必须是 0–100 的整数',
    BAD_POOL_NAME: '卡池名称格式不合法',
    POOL_NOT_FOUND: '所选卡池不存在或已被删除，请重新选择',
    PACKCOUNT_NOT_MULTIPLE: '牌堆总数必须是人数的整数倍',
    FORMAT_PLAYER_COUNT: '淘汰赛人数不能超过比赛人数',
    BAD_SWISS_ROUNDS: '瑞士轮数不合法',
    BAD_PLAYOFF_SIZE: '淘汰赛人数必须是 0 或 2 的幂',
  };
  return messages[error?.code] ?? messages[error?.message] ?? '创建比赛失败，请检查表单后重试';
}

export default function CreateTournamentPage() {
  const [name, setName] = useState('');
  const [maxPlayers, setMaxPlayers] = useState(4);
  const [packSize, setPackSize] = useState(24);
  const [packCount, setPackCount] = useState<number | ''>(16);
  const [packCountTouched, setPackCountTouched] = useState(false);
  const [dropPublic, setDropPublic] = useState(false);
  const [mode, setMode] = useState<'single' | 'match'>('match');
  const [pools, setPools] = useState<PoolInfo[]>([]);
  const [cardPool, setCardPool] = useState('');
  const [mainMin, setMainMin] = useState(40);
  const [mainMax, setMainMax] = useState(60);
  const [extraMax, setExtraMax] = useState(30);
  const [sideMax, setSideMax] = useState(30);
  const [maxCopies, setMaxCopies] = useState(1);
  const [timeLimit, setTimeLimit] = useState(999);
  const [pickSeconds, setPickSeconds] = useState(40);
  const [deckbuildingSeconds, setDeckbuildingSeconds] = useState(600);
  const [limitDeckbuilding, setLimitDeckbuilding] = useState(false);
  const [packStrategy, setPackStrategy] = useState('stratify');
  const [extraRatioEnabled, setExtraRatioEnabled] = useState(false);
  const [extraRatioPercent, setExtraRatioPercent] = useState(25);
  const [evenPackCount, setEvenPackCount] = useState(true);
  const [reseatEachRound, setReseatEachRound] = useState(true);
  const [reserveSeconds, setReserveSeconds] = useState(400);
  const [confirmFairness, setConfirmFairness] = useState(false);
  const [createUsername, setCreateUsername] = useState('');
  const [createToken, setCreateToken] = useState('');
  const [created, setCreated] = useState<{ tid: number; url: string; createdBy: string } | null>(null);
  const [error, setError] = useState('');
  const initialFormat = recommendFormat(4);
  const [matchFormat, setMatchFormat] = useState<MatchFormat>(initialFormat.matchFormat);
  const [swissRoundCount, setSwissRoundCount] = useState(initialFormat.swissRoundCount);
  const [playoffSize, setPlayoffSize] = useState(initialFormat.playoffSize);
  const [formatTouched, setFormatTouched] = useState(false);

  const applyRecommendation = (n: number) => {
    const r = recommendFormat(n);
    setMatchFormat(r.matchFormat);
    setSwissRoundCount(r.swissRoundCount);
    setPlayoffSize(r.playoffSize);
  };

  useEffect(() => {
    api<PoolInfo[]>('/pools', { identity: null })
      .then((p) => {
        setPools(p);
        if (p.length) setCardPool((cur) => cur || p.find((pool) => pool.isDefault)?.name || p[0].name);
      })
      .catch(() => setPools([]));
  }, []);

  // 默认牌堆总数为四轮（4 × 玩家数）；卡池不足时按可用完整牌堆减少轮数。
  // 用户手动编辑后保留其值，超过卡池上限时沿用后端的 use-all/取整规则。
  const poolCount = pools.find((p) => p.name === cardPool)?.count ?? 0;
  const rawMaxPacks = Math.max(1, Math.floor(poolCount / Math.max(1, packSize)));
  const roundedMax = rawMaxPacks - (rawMaxPacks % maxPlayers);
  const maxPacks = evenPackCount ? (roundedMax >= maxPlayers ? roundedMax : rawMaxPacks) : rawMaxPacks;
  const targetPackCount = Math.max(1, maxPlayers * 4);
  const availableDefaultPacks = poolCount > 0 ? Math.max(1, Math.floor(poolCount / Math.max(1, packSize))) : targetPackCount;
  const defaultPackCountRaw = Math.min(targetPackCount, availableDefaultPacks);
  const defaultPackCount = evenPackCount && defaultPackCountRaw >= maxPlayers
    ? Math.max(maxPlayers, defaultPackCountRaw - (defaultPackCountRaw % maxPlayers))
    : defaultPackCountRaw;
  useEffect(() => {
    if (!packCountTouched) setPackCount(defaultPackCount);
  }, [defaultPackCount, packCountTouched]);
  const overLimit = packCount !== '' && Number(packCount) > rawMaxPacks;
  // 超过整除上限时与后端一致：先用尽卡池（ceil），evenPackCount 开再向下取整到人数倍数（>= 人数才取整）
  const ceilPacks = Math.max(1, Math.ceil(poolCount / Math.max(1, packSize)));
  const ceilRounded = ceilPacks - (ceilPacks % maxPlayers);
  const overLimitEffective = evenPackCount && ceilRounded >= maxPlayers ? ceilRounded : ceilPacks;
  const effectivePacks = packCount === '' ? defaultPackCount : overLimit ? overLimitEffective : Number(packCount);
  const draftedCards = Math.min(poolCount, Math.max(0, effectivePacks * packSize));
  const cardsPerPlayerLow = Math.floor(draftedCards / Math.max(1, maxPlayers));
  const cardsPerPlayerHigh = Math.ceil(draftedCards / Math.max(1, maxPlayers));
  const overLimitDrop = Math.max(0, poolCount - overLimitEffective * packSize);
  const packCountInvalid = packCount !== '' && evenPackCount && Number(packCount) % maxPlayers !== 0;
  const extraRatioInvalid = extraRatioEnabled && (!Number.isInteger(extraRatioPercent) || extraRatioPercent < 0 || extraRatioPercent > 100);
  const extraPerPack = extraRatioEnabled ? Math.round(packSize * extraRatioPercent / 100) : 0;
  const mainPerPack = packSize - extraPerPack;
  // passing 模式公平性只取决于牌堆总数是否为人数倍数；每堆张数可以任意。
  const unfair = effectivePacks % maxPlayers !== 0;

  const doCreate = async () => {
    const validationError = validateForm();
    if (validationError) {
      setError(validationError);
      return;
    }
    try {
      const r = await api<{ tid: number; url: string; created_by: string }>('/tournaments', {
        method: 'POST',
        body: { name, maxPlayers, mode, packSize, cardPool, mainMin, mainMax, extraMax, sideMax, maxCopies, timeLimit, pickSeconds, deckbuildingSeconds: limitDeckbuilding ? deckbuildingSeconds : null, packStrategy, extraRatioPercent: extraRatioEnabled ? extraRatioPercent : null, packCount: packCount === '' ? undefined : Number(packCount), dropPublic, evenPackCount, reserveSeconds, reseatEachRound, matchFormat, swissRoundCount: matchFormat === 'swiss' ? swissRoundCount : undefined, playoffSize: matchFormat === 'swiss' ? playoffSize : 0 },
        createUsername: createUsername.trim() || undefined,
        createToken,
      });
      setCreated({ tid: r.tid, url: r.url, createdBy: r.created_by });
      setError('');
    } catch (e: any) {
      setError(readableCreateError(e));
    }
  };

  const validateForm = (): string | null => {
    if (!name.trim()) return '请输入比赛名称';
    if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 32) return '人数必须是 2–32 的整数';
    if (!cardPool.trim()) return '请选择卡池';
    if (!Number.isInteger(packSize) || packSize < 1 || packSize > 1000) return '每堆卡数必须是 1–1000 的整数';
    if (packCount !== '' && (!Number.isInteger(Number(packCount)) || Number(packCount) < 1 || Number(packCount) > 10_000)) return '牌堆总数必须是 1–10000 的整数';
    if (packCountInvalid) return `牌堆总数必须是人数（${maxPlayers}）的整数倍`;
    if (!Number.isInteger(mainMin) || mainMin < 0 || mainMin > 250) return '主卡组最小值必须是 0–250 的整数';
    if (!Number.isInteger(mainMax) || mainMax < 1 || mainMax > 250) return '主卡组最大值必须是 1–250 的整数';
    if (mainMin > mainMax) return '主卡组最小值不能大于最大值';
    if (!Number.isInteger(extraMax) || extraMax < 0 || extraMax > 250) return '额外卡组上限必须是 0–250 的整数';
    if (!Number.isInteger(sideMax) || sideMax < 0 || sideMax > 250) return '副卡组上限必须是 0–250 的整数';
    if (!Number.isInteger(maxCopies) || maxCopies < 1 || maxCopies > 100) return '单卡上限必须是 1–100 的整数';
    if (!Number.isInteger(timeLimit) || timeLimit < 1 || timeLimit > 999) return '回合限时必须是 1–999 秒的整数';
    if (!Number.isInteger(pickSeconds) || pickSeconds < 1 || pickSeconds > 7 * 24 * 60 * 60) return '选牌限时必须是正整数';
    if (limitDeckbuilding && (!Number.isInteger(deckbuildingSeconds) || deckbuildingSeconds < 1 || deckbuildingSeconds > 7 * 24 * 60 * 60)) return '构筑限时必须是正整数';
    if (!Number.isInteger(reserveSeconds) || reserveSeconds < 0 || reserveSeconds > 7 * 24 * 60 * 60) return '保留时间必须是 0 或正整数';
    if (extraRatioInvalid) return '额外卡比例必须是 0–100 的整数';
    if (matchFormat === 'swiss') {
      const maxRounds = maxPlayers % 2 === 0 ? maxPlayers - 1 : maxPlayers;
      if (!Number.isInteger(swissRoundCount) || swissRoundCount < 1 || swissRoundCount > maxRounds) return `瑞士轮数必须是 1–${maxRounds} 的整数`;
      if (!Number.isInteger(playoffSize) || playoffSize < 0 || playoffSize > maxPlayers || (playoffSize !== 0 && (playoffSize < 2 || (playoffSize & (playoffSize - 1)) !== 0))) return '淘汰赛人数必须是 0 或不超过人数的 2 的幂';
    }
    return null;
  };

  const create = () => {
    const validationError = validateForm();
    if (validationError) {
      setError(validationError);
      return;
    }
    if (unfair) {
      setConfirmFairness(true);
      return;
    }
    void doCreate();
  };

  return (
    <main className="mx-auto max-w-3xl p-4 sm:p-8">
      <a href="/" className="mb-5 inline-flex items-center gap-2 text-xs text-emerald-100/60 hover:text-gold">← 返回首页</a>
      <p className="yc-kicker mb-1">Tournament setup</p>
      <h1 className="yc-title mb-6 text-3xl font-bold">创建比赛</h1>
      {created ? (
        <div className="yc-panel space-y-3 p-6">
          <p className="mb-2">比赛创建成功。</p>
          <a href={created.url} className="block font-mono text-gold underline">
            {created.url}
          </a>
          <p className="text-xs text-slate-400">创建者：<b className="text-gold">{created.createdBy}</b>。后续请在管理台使用相同的创建用户名和 token；权限仅限自己创建的比赛。</p>
          <a href="/admin" className="inline-block rounded bg-felt-edge px-4 py-1.5 text-sm hover:brightness-110">
            管理控制台
          </a>
        </div>
      ) : (
        <div className="yc-panel space-y-5 p-5 sm:p-7">
          <input
            className="w-full rounded bg-felt-deep px-3 py-2 outline-none ring-gold/50 focus:ring-2"
            placeholder="比赛名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              人数
              <input
                type="number"
                min={2}
                max={64}
                className="w-16 rounded bg-felt-deep px-2 py-1"
                value={maxPlayers}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  setMaxPlayers(n);
                  if (!formatTouched) applyRecommendation(n);
                }}
              />
            </label>
            <label className="flex items-center gap-2">
              模式
              <select className="rounded bg-felt-deep px-2 py-1" value={mode} onChange={(e) => setMode(e.target.value as 'single' | 'match')}>
                <option value="match">三局两胜（BO3）</option>
                <option value="single">单局（BO1）</option>
              </select>
            </label>
            <label className="flex items-center gap-2">
              每堆卡数
              <input
                type="number"
                min={1}
                max={60}
                className="w-16 rounded bg-felt-deep px-2 py-1"
                value={packSize}
                onChange={(e) => setPackSize(Math.max(1, Number(e.target.value)))}
              />
              <span className="text-xs text-slate-400">每个完整轮次每位玩家获得 {packSize} 张</span>
            </label>
            <label className="flex items-center gap-2">
              卡池
              <select className="rounded bg-felt-deep px-2 py-1" value={cardPool} onChange={(e) => setCardPool(e.target.value)}>
                {pools.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name} ({p.count})
                  </option>
                ))}
              </select>
              {pools.length === 0 && <span className="text-xs text-red-300">暂无可用卡池，请先由管理员创建</span>}
            </label>
          </div>
          <section className="rounded-lg border border-gold/25 bg-felt-deep/45 p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div><p className="yc-kicker">Match format</p><h2 className="font-semibold text-gold">赛制</h2></div>
              <button type="button" className="rounded bg-felt-edge px-3 py-1 text-xs hover:brightness-110" onClick={() => { applyRecommendation(maxPlayers); setFormatTouched(false); }}>应用 {maxPlayers} 人推荐</button>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              {([
                ['round_robin', '单循环', '每两名玩家交手一次'],
                ['swiss', '瑞士轮', '自定义轮数及单败淘汰'],
                ['double_elimination', '双败淘汰', '两败淘汰，单场总决赛'],
              ] as const).map(([value, title, desc]) => (
                <button key={value} type="button" onClick={() => { setMatchFormat(value); setFormatTouched(true); }} className={`rounded border p-3 text-left transition ${matchFormat === value ? 'border-gold bg-gold/10' : 'border-felt-edge hover:border-gold/40'}`}>
                  <b className="block text-sm text-gold">{title}</b><span className="text-xs text-slate-400">{desc}</span>
                </button>
              ))}
            </div>
            {matchFormat === 'swiss' && <div className="mt-3 flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2">瑞士轮数 <input type="number" min={1} max={64} className="w-16 rounded bg-felt px-2 py-1" value={swissRoundCount} onChange={(e) => { setSwissRoundCount(Math.max(1, Number(e.target.value))); setFormatTouched(true); }} /></label>
              <label className="flex items-center gap-2">淘汰赛人数 <select className="rounded bg-felt px-2 py-1" value={playoffSize} onChange={(e) => { setPlayoffSize(Number(e.target.value)); setFormatTouched(true); }}>
                {[0, 2, 4, 8, 16, 32, 64].filter((n) => n === 0 || n <= maxPlayers).map((n) => <option key={n} value={n}>{n === 0 ? '无淘汰赛' : `Top ${n}`}</option>)}
              </select></label>
            </div>}
          </section>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              主卡组
              <input type="number" min={20} max={80} className="w-14 rounded bg-felt-deep px-2 py-1" value={mainMin} onChange={(e) => setMainMin(Number(e.target.value))} />
              -
              <input type="number" min={20} max={80} className="w-14 rounded bg-felt-deep px-2 py-1" value={mainMax} onChange={(e) => setMainMax(Number(e.target.value))} />
            </label>
            <label className="flex items-center gap-2">
              额外上限
              <input type="number" min={0} max={30} className="w-14 rounded bg-felt-deep px-2 py-1" value={extraMax} onChange={(e) => setExtraMax(Number(e.target.value))} />
            </label>
            <label className="flex items-center gap-2">
              副卡组上限
              <input type="number" min={0} max={30} className="w-14 rounded bg-felt-deep px-2 py-1" value={sideMax} onChange={(e) => setSideMax(Number(e.target.value))} />
            </label>
            <label className="flex items-center gap-2">
              单卡上限
              <input type="number" min={1} max={3} className="w-14 rounded bg-felt-deep px-2 py-1" value={maxCopies} onChange={(e) => setMaxCopies(Math.min(3, Math.max(1, Number(e.target.value))))} />
            </label>
            <label className="flex items-center gap-2">
              回合限时（秒）
              <input type="number" min={60} max={999} className="w-16 rounded bg-felt-deep px-2 py-1" value={timeLimit} onChange={(e) => setTimeLimit(Math.min(999, Math.max(60, Number(e.target.value))))} />
            </label>
            <label className="flex items-center gap-2">
              选牌限时（秒）
              <input type="number" min={5} max={300} className="w-16 rounded bg-felt-deep px-2 py-1" value={pickSeconds} onChange={(e) => setPickSeconds(Number(e.target.value))} />
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={limitDeckbuilding} onChange={(e) => setLimitDeckbuilding(e.target.checked)} />
              限制构筑时间
              {limitDeckbuilding ? (
                <><input type="number" min={30} max={7200} className="w-20 rounded bg-felt-deep px-2 py-1" value={deckbuildingSeconds} onChange={(e) => setDeckbuildingSeconds(Number(e.target.value))} /> 秒</>
              ) : <span className="text-xs text-slate-400">无限；由管理员手动进入对战</span>}
            </label>
            <label className="flex items-center gap-2">
              保留时间（秒）
              <input type="number" min={0} max={3600} className="w-16 rounded bg-felt-deep px-2 py-1" value={reserveSeconds} onChange={(e) => setReserveSeconds(Math.max(0, Number(e.target.value)))} />
            </label>
            <label className="flex items-center gap-2">
              牌堆总数（轮数）
              <input
                type="number"
                min={1}
                className="w-16 rounded bg-felt-deep px-2 py-1"
                placeholder="自动"
                value={packCount}
                onChange={(e) => {
                  setPackCountTouched(true);
                  setPackCount(e.target.value === '' ? '' : Math.max(1, Number(e.target.value)));
                }}
              />
              <span className="text-xs text-slate-400">默认 {defaultPackCount} 堆（{Math.max(1, Math.ceil(defaultPackCount / Math.max(1, maxPlayers)))} 轮）</span>
              {cardPool ? (
                overLimit && !evenPackCount ? (
                  <span className="text-xs text-amber-300">
                    超过整除上限（{rawMaxPacks} 堆）：将使用全部 {poolCount} 张卡牌，不丢弃（最后一堆可能不满）
                  </span>
                ) : overLimit && evenPackCount ? (
                  <span className="text-xs text-amber-300">
                    超过整除上限（{rawMaxPacks} 堆）：将取整到 {effectivePacks} 堆（{maxPlayers} 的倍数）
                    {overLimitDrop > 0 ? `，必然丢弃 ${overLimitDrop} 张卡牌` : '，恰好用尽卡池不丢弃'}
                  </span>
                ) : (
                  <span className="text-xs text-slate-400">
                    上限 {maxPacks} 堆{evenPackCount ? `（${maxPlayers} 的倍数）` : ''} · 使用 {effectivePacks * packSize} 张 · 剩余{' '}
                    {Math.max(0, poolCount - effectivePacks * packSize)} 张随机丢弃
                  </span>
                )
              ) : (
                <span className="text-xs text-slate-500">请先选择卡池</span>
              )}
              {packCountInvalid && <span className="text-xs text-red-300">牌堆总数必须是人数（{maxPlayers}）的整数倍</span>}
            </label>
            <div className="flex items-center rounded border border-emerald-300/20 bg-emerald-950/30 px-3 py-1.5 text-xs text-emerald-100">
              每位玩家可获得：{cardsPerPlayerLow === cardsPerPlayerHigh ? <b className="ml-1 text-gold">{cardsPerPlayerLow} 张</b> : <b className="ml-1 text-amber-300">{cardsPerPlayerLow}–{cardsPerPlayerHigh} 张</b>}
              <span className="ml-2 text-slate-400">（按实际使用 {draftedCards} 张计算）</span>
            </div>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={evenPackCount} onChange={(e) => setEvenPackCount(e.target.checked)} />
              牌堆数为人数整数倍
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={dropPublic} onChange={(e) => setDropPublic(e.target.checked)} />
              公开被丢弃的卡牌
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={reseatEachRound} onChange={(e) => setReseatEachRound(e.target.checked)} />
              每轮结束后随机重排玩家座位
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={extraRatioEnabled} onChange={(e) => setExtraRatioEnabled(e.target.checked)} />
              按比例配置额外卡
              {extraRatioEnabled && (
                <>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    className="w-16 rounded bg-felt-deep px-2 py-1"
                    value={extraRatioPercent}
                    onChange={(e) => setExtraRatioPercent(e.target.value === '' ? 0 : Number(e.target.value))}
                  />
                  <span>%（每个完整牌堆 {mainPerPack} 主卡 + {extraPerPack} 额外卡）</span>
                </>
              )}
              {extraRatioInvalid && <span className="text-xs text-red-300">比例必须是 0–100 的整数</span>}
            </label>
            <label className="flex items-center gap-2">
              卡堆组成
              <select className="rounded bg-felt-deep px-2 py-1 disabled:cursor-not-allowed disabled:opacity-50" disabled={extraRatioEnabled} value={packStrategy} onChange={(e) => setPackStrategy(e.target.value)}>
                <option value="stratify">主卡/额外卡按比例均匀每堆</option>
                <option value="random">全随机</option>
                <option value="main_then_extra">先全主卡再全额外</option>
              </select>
              {extraRatioEnabled && <span className="text-xs text-amber-200">比例配置优先</span>}
            </label>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <input
              className="w-full rounded bg-felt-deep px-3 py-2 outline-none ring-gold/50 focus:ring-2"
              placeholder="权限用户名（超级管理员可留空）"
              autoComplete="username"
              value={createUsername}
              onChange={(e) => setCreateUsername(e.target.value)}
            />
            <input
              className="w-full rounded bg-felt-deep px-3 py-2 outline-none ring-gold/50 focus:ring-2"
              placeholder="创建 token"
              type="password"
              autoComplete="off"
              value={createToken}
              onChange={(e) => setCreateToken(e.target.value)}
            />
          </div>
          <p className="text-xs text-slate-500">创建权限用户由超级管理员在管理台生成；超级管理员也可直接只填写 token。</p>
          {error && <p className="text-xs text-red-300">{error}</p>}
          <button onClick={create} disabled={!cardPool || packCountInvalid || extraRatioInvalid} className="yc-primary px-6 py-2.5 font-semibold disabled:cursor-not-allowed disabled:opacity-40">
            创建比赛
          </button>
          <ConfirmModal
            open={confirmFairness}
            title="可能不公平，确认创建？"
            onCancel={() => setConfirmFairness(false)}
            onConfirm={() => {
              setConfirmFairness(false);
              void doCreate();
            }}
            confirmText="仍然创建"
          >
            <p className="text-xs leading-relaxed text-slate-300">
              实际牌堆总数不是人数（{maxPlayers}）的整数倍：最后一轮无法让所有玩家各获得一堆。每堆卡数可以任意，无需是人数的倍数。
            </p>
          </ConfirmModal>
        </div>
      )}
    </main>
  );
}
