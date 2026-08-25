'use client';

// 根目录仅作入口，不暴露创建表单（创建请走 /create-tournament，需创建令牌）
export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl items-center px-5 py-12 sm:px-8">
      <section className="yc-panel w-full p-7 sm:p-10">
        <p className="yc-kicker mb-3">YGO Cube</p>
        <h1 className="yc-title text-4xl font-black tracking-tight sm:text-5xl">轮抽、构筑、对战</h1>
        <p className="mt-4 max-w-xl text-sm leading-6 text-slate-300">
          共享卡池轮抽与在线赛程管理。选择一个入口开始。
        </p>
        <nav className="mt-7 flex flex-wrap gap-3" aria-label="主要入口">
          <a href="/create-tournament" className="yc-primary px-5 py-2.5 text-sm font-bold">创建比赛</a>
          <a href="/admin" className="yc-secondary px-5 py-2.5 text-sm font-semibold">管理控制台</a>
        </nav>
      </section>
    </main>
  );
}
