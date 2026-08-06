'use client';

// 根目录仅作入口，不暴露创建表单（创建请走 /create-tournament，需创建令牌）
export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6">
      <h1 className="text-3xl font-bold text-gold">YGO Cube</h1>
      <p className="text-sm text-slate-400">轮抽模式对战系统</p>
      <div className="flex gap-4">
        <a href="/create-tournament" className="rounded bg-gold px-6 py-2 font-semibold text-felt-deep hover:brightness-110">
          创建比赛
        </a>
        <a href="/admin" className="rounded bg-felt-edge px-6 py-2 text-slate-200 hover:brightness-110">
          管理控制台
        </a>
      </div>
    </main>
  );
}
