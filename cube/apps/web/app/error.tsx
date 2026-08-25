'use client';

import { useEffect } from 'react';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Keep diagnostics local to the browser; never render stack traces or send
    // credentials along with an error report.
    console.error('web page error', error);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-screen max-w-lg items-center px-5 py-12">
      <section className="yc-panel w-full space-y-4 p-6" role="alert">
        <h1 className="text-lg font-semibold text-gold">页面暂时无法加载</h1>
        <p className="text-sm text-slate-300">请重试；比赛状态仍由服务器保存。</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => reset()} className="yc-primary px-4 py-2 text-sm font-semibold">重试</button>
          <a href="/" className="yc-secondary px-4 py-2 text-sm font-semibold">返回首页</a>
        </div>
      </section>
    </main>
  );
}
