'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { ConfirmModal } from '@/components/ConfirmModal';

interface PoolInfo {
  name: string;
  count: number;
}

export default function CreateTournamentPage() {
  const [name, setName] = useState('');
  const [maxPlayers, setMaxPlayers] = useState(4);
  const [packSize, setPackSize] = useState(12);
  const [packTouched, setPackTouched] = useState(false);
  const [packCount, setPackCount] = useState<number | ''>('');
  const [dropPublic, setDropPublic] = useState(true);
  const [mode, setMode] = useState<'single' | 'match'>('match');
  const [pools, setPools] = useState<PoolInfo[]>([]);
  const [cardPool, setCardPool] = useState('');
  const [mainMin, setMainMin] = useState(40);
  const [mainMax, setMainMax] = useState(60);
  const [extraMax, setExtraMax] = useState(30);
  const [sideMax, setSideMax] = useState(30);
  const [maxCopies, setMaxCopies] = useState(1);
  const [timeLimit, setTimeLimit] = useState(999);
  const [pickSeconds, setPickSeconds] = useState(30);
  const [deckbuildingSeconds, setDeckbuildingSeconds] = useState(600);
  const [packStrategy, setPackStrategy] = useState('stratify');
  const [evenPackCount, setEvenPackCount] = useState(true);
  const [reserveSeconds, setReserveSeconds] = useState(300);
  const [confirmFairness, setConfirmFairness] = useState(false);
  const [createToken, setCreateToken] = useState('');
  const [created, setCreated] = useState<{ url: string; adminToken: string } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<PoolInfo[]>('/pools', { identity: null })
      .then((p) => {
        setPools(p);
        if (p.length) setCardPool((cur) => cur || p[0].name);
      })
      .catch(() => setPools([]));
  }, []);

  // 牌堆数上限/估算（与后端 startDraft 逻辑一致；evenPackCount 开时向下取整到人数倍数）
  // 留空 = 自动（maxPacks）；超过整除上限时：evenPackCount 关 = 用尽卡池（末堆可能不满），开 = 向下取整到人数倍数
  const poolCount = pools.find((p) => p.name === cardPool)?.count ?? 0;
  const rawMaxPacks = Math.max(1, Math.floor(poolCount / Math.max(1, packSize)));
  const roundedMax = rawMaxPacks - (rawMaxPacks % maxPlayers);
  const maxPacks = evenPackCount ? (roundedMax >= maxPlayers ? roundedMax : rawMaxPacks) : rawMaxPacks;
  const autoEstimate = maxPacks;
  const overLimit = packCount !== '' && Number(packCount) > rawMaxPacks;
  // 超过整除上限时与后端一致：先用尽卡池（ceil），evenPackCount 开再向下取整到人数倍数（>= 人数才取整）
  const ceilPacks = Math.max(1, Math.ceil(poolCount / Math.max(1, packSize)));
  const ceilRounded = ceilPacks - (ceilPacks % maxPlayers);
  const overLimitEffective = evenPackCount && ceilRounded >= maxPlayers ? ceilRounded : ceilPacks;
  const effectivePacks = packCount === '' ? autoEstimate : overLimit ? overLimitEffective : Number(packCount);
  const overLimitDrop = Math.max(0, poolCount - overLimitEffective * packSize);
  const packCountInvalid = packCount !== '' && evenPackCount && Number(packCount) % maxPlayers !== 0;
  // 公平性警告：每堆卡数或牌堆数非人数整数倍（各玩家选牌次数可能不等）
  const unfair =
    packSize % maxPlayers !== 0 ||
    (packCount !== '' && Number(packCount) % maxPlayers !== 0) ||
    (!evenPackCount && packCount === '' && autoEstimate % maxPlayers !== 0);

  const doCreate = async () => {
    try {
      const r = await api<{ tid: number; url: string; admin_token: string }>('/tournaments', {
        method: 'POST',
        body: { name, maxPlayers, mode, packSize, cardPool, mainMin, mainMax, extraMax, sideMax, maxCopies, timeLimit, pickSeconds, deckbuildingSeconds, packStrategy, packCount: packCount === '' ? undefined : Number(packCount), dropPublic, evenPackCount, reserveSeconds },
        createToken,
      });
      setCreated({ url: r.url, adminToken: r.admin_token });
      setError('');
    } catch (e: any) {
      setError(e.code === 'AUTH_REQUIRED' ? '缺少创建令牌' : (e.code === 'PACKCOUNT_NOT_MULTIPLE' ? '牌堆总数必须是人数的整数倍' : (e.code ?? String(e))));
    }
  };

  const create = () => {
    if (unfair) {
      setConfirmFairness(true);
      return;
    }
    void doCreate();
  };

  return (
    <main className="mx-auto max-w-2xl p-4 sm:p-8">
      <h1 className="mb-6 text-3xl font-bold text-gold">创建比赛</h1>
      {created ? (
        <div className="space-y-3 rounded-lg border border-felt-edge bg-felt p-4">
          <p className="mb-2">比赛创建成功。</p>
          <a href={created.url} className="block font-mono text-gold underline">
            {created.url}
          </a>
          <div>
            <p className="text-xs text-slate-400">比赛专属管理令牌（请妥善保存，仅可管理本场比赛）：</p>
            <code className="block break-all rounded bg-felt-deep p-3 font-mono text-xs text-gold">{created.adminToken}</code>
          </div>
          <a href="/admin" className="inline-block rounded bg-felt-edge px-4 py-1.5 text-sm hover:brightness-110">
            管理控制台
          </a>
        </div>
      ) : (
        <div className="space-y-4 rounded-lg border border-felt-edge bg-felt p-6">
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
                  if (!packTouched) setPackSize(Math.max(1, n * 3));
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
              每堆卡数（建议 {maxPlayers * 3}）
              <input
                type="number"
                min={1}
                max={60}
                className="w-16 rounded bg-felt-deep px-2 py-1"
                value={packSize}
                onChange={(e) => { setPackTouched(true); setPackSize(Math.max(1, Number(e.target.value))); }}
              />
              {packSize % maxPlayers !== 0 && (
                <span className="text-xs text-amber-300">非人数整数倍：各玩家从每堆选牌的次数可能不同</span>
              )}
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
              构筑限时（秒）
              <input type="number" min={30} max={7200} className="w-20 rounded bg-felt-deep px-2 py-1" value={deckbuildingSeconds} onChange={(e) => setDeckbuildingSeconds(Number(e.target.value))} />
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
                onChange={(e) => setPackCount(e.target.value === '' ? '' : Math.max(1, Number(e.target.value)))}
              />
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
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={evenPackCount} onChange={(e) => setEvenPackCount(e.target.checked)} />
              牌堆数为人数整数倍
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={dropPublic} onChange={(e) => setDropPublic(e.target.checked)} />
              公开被丢弃的卡牌
            </label>
            <label className="flex items-center gap-2">
              卡堆组成
              <select className="rounded bg-felt-deep px-2 py-1" value={packStrategy} onChange={(e) => setPackStrategy(e.target.value)}>
                <option value="stratify">主卡/额外卡按比例均匀每堆</option>
                <option value="random">全随机</option>
                <option value="main_then_extra">先全主卡再全额外</option>
              </select>
            </label>
          </div>
          <input
            className="w-full rounded bg-felt-deep px-3 py-2 outline-none ring-gold/50 focus:ring-2"
            placeholder="创建令牌"
            type="password"
            value={createToken}
            onChange={(e) => setCreateToken(e.target.value)}
          />
          {error && <p className="text-xs text-red-300">{error}</p>}
          <button onClick={create} disabled={!cardPool || packCountInvalid} className="rounded bg-gold px-6 py-2 font-semibold text-felt-deep transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40">
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
              每堆卡数或牌堆总数不是人数（{maxPlayers}）的整数倍：传递式轮抽中各玩家的选牌次数可能不相等。建议调整每堆卡数/牌堆总数为 {maxPlayers} 的整数倍。
            </p>
          </ConfirmModal>
        </div>
      )}
    </main>
  );
}
