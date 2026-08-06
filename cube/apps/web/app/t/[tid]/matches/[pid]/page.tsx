'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, Identity, resolvePlayerIdentity } from '@/lib/api';
import { useTournamentStream } from '@/lib/sse';
import { DraftState } from '@/components/TopBar';
import { TokenPrompt } from '@/components/TokenPrompt';

interface MatchInfo {
  id: number;
  round: number;
  tableNo: number;
  playerA: string;
  opponent: string;
  roomName: string | null;
  resultA: number | null;
  resultB: number | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export default function MatchesPage() {
  const params = useParams<{ tid: string; pid: string }>();
  const tid = params.tid;
  const pid = params.pid;
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [needToken, setNeedToken] = useState(false);
  const [matches, setMatches] = useState<MatchInfo[]>([]);
  const [info, setInfo] = useState<DraftState | null>(null);
  const [copied, setCopied] = useState(false);
  const [server, setServer] = useState<{ host: string; port: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const info = await api<{ authRequired: boolean }>(`/t/${tid}`, { identity: null });
        if (!cancelled) {
          if (info.authRequired === false) {
            setIdentity({ tid, pid, token: '' });
          } else {
            const r = resolvePlayerIdentity(tid, pid);
            if ('needToken' in r) setNeedToken(true);
            else setIdentity(r.identity);
          }
        }
      } catch {
        if (!cancelled) setIdentity(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tid, pid]);

  const load = useCallback(async () => {
    if (!identity) return;
    try {
      const [ms, st] = await Promise.all([
        api<MatchInfo[]>(`/t/${tid}/matches`, { identity }),
        api<DraftState>(`/t/${tid}/state`, { identity }),
      ]);
      setMatches(ms);
      setInfo(st);
    } catch (e: any) {
      if (e.code === 'AUTH_REQUIRED') {
        setIdentity(null);
        setNeedToken(true);
      }
    }
  }, [tid, identity]);

  useEffect(() => {
    void load();
  }, [load]);

  // 对局服务器地址/端口来自 config.yaml（srvpro.game_port）
  useEffect(() => {
    api<{ srvpro: { host: string; gamePort: number } }>('/meta', { identity: null })
      .then((m) => setServer({ host: m.srvpro.host, port: m.srvpro.gamePort }))
      .catch(() => setServer({ host: '127.0.0.1', port: 7911 }));
  }, []);

  useTournamentStream(tid, identity, useCallback(() => void load(), [load]));

  if (needToken) return <TokenPrompt tid={tid} pid={pid} onToken={(t) => { setNeedToken(false); setIdentity({ tid, pid, token: t }); }} />;
  if (!info) return <main className="p-8 text-slate-400">加载中...</main>;

  const myMatch = matches.find((m) => m.resultA === null && m.resultB === null);
  const cfg = (info?.config ?? {}) as { mainMin?: number; mainMax?: number; extraMax?: number; sideMax?: number; timeLimit?: number };
  const ruleText =
    cfg.mainMin != null
      ? `主卡组 ${cfg.mainMin}-${cfg.mainMax} 张、额外卡组 ${cfg.extraMax} 张、副卡组 ${cfg.sideMax} 张、基本分 8000、每回合 ${cfg.timeLimit ?? 180} 秒`
      : '';

  const resultCell = (m: MatchInfo) => {
    if (m.resultA === null || m.resultB === null) return <span className="text-slate-400">对局中</span>;
    const isA = m.playerA === pid;
    const my = isA ? m.resultA : m.resultB;
    const opp = isA ? m.resultB : m.resultA;
    const cls = my > opp ? 'text-emerald-400' : my < opp ? 'text-red-400' : 'text-slate-300';
    const badge = my > opp ? 'W' : my < opp ? 'L' : 'D';
    return (
      <span className={cls}>
        {badge} {my} : {opp}
      </span>
    );
  };

  return (
    <main className="mx-auto max-w-3xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-bold text-gold">
          对战 — 第 {info.round} <span className="text-sm font-normal text-slate-400">（{pid}）</span>
        </h1>
        <a
          href={`/t/${tid}/ranking/${encodeURIComponent(pid)}`}
          className="rounded bg-felt-edge px-3 py-1.5 text-sm text-gold hover:brightness-110"
        >
          查看积分榜单
        </a>
      </div>
      <table className="w-full overflow-hidden rounded-lg border border-felt-edge text-sm">
        <thead className="bg-felt text-left text-xs text-slate-400">
          <tr>
            <th className="px-3 py-2">Round</th>
            <th className="px-3 py-2">#</th>
            <th className="px-3 py-2">You</th>
            <th className="px-3 py-2">vs</th>
            <th className="px-3 py-2">Opponent</th>
            <th className="px-3 py-2">Result</th>
            <th className="px-3 py-2">Room</th>
          </tr>
        </thead>
        <tbody className="bg-felt/60">
          {matches.length === 0 && (
            <tr>
              <td colSpan={7} className="px-3 py-4 text-center text-slate-500">
                暂无对阵安排
              </td>
            </tr>
          )}
          {matches.map((m) => (
            <tr key={m.id} className="border-t border-felt-edge">
              <td className="px-3 py-2 font-mono text-xs text-slate-400">R{m.round}</td>
              <td className="px-3 py-2">{m.tableNo}</td>
              <td className="px-3 py-2 font-semibold text-gold">{pid}</td>
              <td className="px-3 py-2 text-slate-500">vs</td>
              <td className="px-3 py-2">{m.opponent}</td>
              <td className="px-3 py-2 font-mono">{resultCell(m)}</td>
              <td className="px-3 py-2 font-mono text-xs">{m.roomName ?? '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {myMatch && (
        <div className="mt-6 rounded-lg border border-gold/40 bg-felt p-4">
          <h2 className="mb-2 text-sm font-semibold text-gold">你的对局 — 第 {myMatch.tableNo}</h2>
          <p className="text-sm text-slate-300">
            对手： <b>{myMatch.opponent}</b>
          </p>
          <p className="mt-2 text-xs text-slate-400">
            打开修改版 YGOPro-Cube 客户端，连接服务器{' '}
            <code className="font-mono text-gold">{server ? `${server.host}:${server.port}` : '读取中...'}</code>
            ，加入房间 <code className="font-mono text-gold">{myMatch.roomName ?? '等待创建房间...'}</code>
            ，昵称填写 <code className="font-mono text-gold">{pid}</code>。
          </p>
          {myMatch.roomName && (
            <button
              onClick={() => {
                navigator.clipboard.writeText(
                  `服务器:${server?.host ?? '127.0.0.1'}:${server?.port ?? 7911} 房间号:${myMatch.roomName ?? ''} 昵称:${pid}${ruleText ? ` 规则:${ruleText}` : ''}`,
                );
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="mt-3 rounded bg-gold px-4 py-1.5 text-sm font-semibold text-felt-deep hover:brightness-110"
            >
              {copied ? '已复制' : '复制加入信息'}
            </button>
          )}
        </div>
      )}

      {ruleText && (
        <div className="mt-4 rounded-lg border border-felt-edge bg-felt/60 p-3 text-xs text-slate-400">
          房间规则：<code className="font-mono text-gold">{ruleText}</code>
          <span className="ml-2">（进房时房间密码即上方房间号）</span>
        </div>
      )}

      <div className="mt-4 text-xs text-slate-500">
        服务器地址与端口由管理员在 config.yaml（srvpro.game_port）中配置；进房昵称即你的玩家 ID，请勿填错房间。
      </div>
    </main>
  );
}
