'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

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
  const [dropMode, setDropMode] = useState('drop_leftover');
  const [packStrategy, setPackStrategy] = useState('stratify');
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

  const create = async () => {
    try {
      const r = await api<{ tid: number; url: string; admin_token: string }>('/tournaments', {
        method: 'POST',
        body: { name, maxPlayers, mode, packSize, cardPool, mainMin, mainMax, extraMax, sideMax, maxCopies, timeLimit, pickSeconds, deckbuildingSeconds, dropMode, packStrategy, packCount: packCount === '' ? undefined : Number(packCount), dropPublic },
        createToken,
      });
      setCreated({ url: r.url, adminToken: r.admin_token });
      setError('');
    } catch (e: any) {
      setError(e.code === 'AUTH_REQUIRED' ? '缺少创建令牌' : (e.code ?? String(e)));
    }
  };

  return (
    <main className="mx-auto max-w-2xl p-8">
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
              剩余卡处理
              <select className="rounded bg-felt-deep px-2 py-1" value={dropMode} onChange={(e) => setDropMode(e.target.value)}>
                <option value="use_all">使用所有卡牌</option>
                <option value="drop_leftover">丢弃无法整除的剩余卡牌</option>
                <option value="drop_leftover_exact">丢弃且要求牌堆数目是玩家整数倍</option>
              </select>
            </label>
            <label className="flex items-center gap-2">
              牌堆总数（轮数）
              <input
                type="number"
                min={1}
                max={Math.max(1, Math.floor((pools.find((p) => p.name === cardPool)?.count ?? 0) / Math.max(1, packSize)))}
                className="w-16 rounded bg-felt-deep px-2 py-1"
                placeholder="自动"
                value={packCount}
                onChange={(e) => setPackCount(e.target.value === '' ? '' : Math.max(1, Number(e.target.value)))}
              />
              {cardPool ? (
                <span className="text-xs text-slate-400">
                  上限 {Math.max(1, Math.floor((pools.find((p) => p.name === cardPool)?.count ?? 0) / Math.max(1, packSize)))} 堆 · 使用{' '}
                  {(packCount === '' ? Math.floor((pools.find((p) => p.name === cardPool)?.count ?? 0) / Math.max(1, packSize)) : Number(packCount)) * packSize} 张 · 剩余{' '}
                  {Math.max(0, (pools.find((p) => p.name === cardPool)?.count ?? 0) - (packCount === '' ? Math.floor((pools.find((p) => p.name === cardPool)?.count ?? 0) / Math.max(1, packSize)) : Number(packCount)) * packSize)} 张随机丢弃
                </span>
              ) : (
                <span className="text-xs text-slate-500">请先选择卡池</span>
              )}
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
          <button onClick={create} disabled={!cardPool} className="rounded bg-gold px-6 py-2 font-semibold text-felt-deep transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40">
            创建比赛
          </button>
        </div>
      )}
    </main>
  );
}
