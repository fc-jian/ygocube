'use client';

// 根目录仅作入口，不暴露创建表单（创建请走 /create-tournament，需创建令牌）
export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-6xl items-center px-5 py-12 sm:px-8">
      <div className="yc-panel grid w-full overflow-hidden lg:grid-cols-[1.05fr_0.95fr]">
        <section className="flex flex-col justify-center p-8 sm:p-12 lg:p-16">
          <p className="yc-kicker mb-4">Draft · Build · Duel</p>
          <h1 className="yc-title text-5xl font-black tracking-tight sm:text-6xl">YGO Cube</h1>
          <p className="mt-5 max-w-lg text-lg font-medium text-slate-100">让每一次选牌，都成为下一场决斗的伏笔。</p>
          <p className="mt-3 max-w-xl text-sm leading-7 text-slate-400">
            从共享卡池轮抽、在线构筑，到自动建房与赛程管理，一处完成完整的 Cube 对战流程。
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a href="/create-tournament" className="yc-primary px-6 py-3 text-sm font-bold">
              创建比赛
            </a>
            <a href="/admin" className="yc-secondary px-6 py-3 text-sm font-semibold">
              管理控制台
            </a>
          </div>
          <div className="mt-10 grid max-w-lg grid-cols-3 gap-3 border-t border-emerald-100/10 pt-5 text-xs text-slate-400">
            <span><b className="mb-1 block text-base text-emerald-100">实时</b>传递式轮抽</span>
            <span><b className="mb-1 block text-base text-emerald-100">统一</b>构筑与房间</span>
            <span><b className="mb-1 block text-base text-emerald-100">可靠</b>事件回溯</span>
          </div>
        </section>
        <section className="relative hidden min-h-[34rem] items-center justify-center overflow-hidden border-l border-emerald-100/10 bg-[radial-gradient(circle_at_center,rgba(64,151,115,0.24),transparent_58%)] lg:flex" aria-hidden="true">
          <div className="absolute inset-10 rounded-full border border-emerald-100/10 shadow-[0_0_0_4rem_rgba(47,128,95,0.025),0_0_0_8rem_rgba(212,175,55,0.018)]" />
          <div className="yc-card-fan flex items-center">
            <div className="yc-card-art" />
            <div className="yc-card-art" />
            <div className="yc-card-art" />
          </div>
          <span className="absolute bottom-10 text-[0.65rem] font-semibold uppercase tracking-[0.35em] text-emerald-100/40">Forge your deck</span>
        </section>
      </div>
    </main>
  );
}
