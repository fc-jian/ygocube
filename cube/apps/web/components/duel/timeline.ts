// Presentation pacing only. Protocol bytes and prompt revisions keep their order.
export function framePause(frame: Uint8Array): number {
  if (frame[2] !== 1) return 0;
  const message = frame[3];
  if (message === 40 || message === 41) return 950;
  if (message === 50) return 480;
  if (message === 90)
    return 480 + Math.min(9, Math.max(0, (frame[5] ?? 1) - 1)) * 75;
  if ([60, 62, 64, 110].includes(message)) return 650;
  if (message === 70) return 1000;
  if (message === 72) return 850;
  if (message === 73) return 250;
  if ([71, 74, 75, 76].includes(message)) return 500;
  if ([83, 91, 92, 94, 100].includes(message)) return 350;
  return 0;
}

type Entry = { run: (scale: number) => void; pause: number };
export class DuelTimeline {
  private queue: Entry[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private deadline = 0;
  constructor(private now = () => performance.now()) {}
  push(run: Entry["run"], pause = 0) {
    if (!this.queue.length) this.deadline = this.now() + 2500;
    this.queue.push({ run, pause });
    if (!this.timer) this.next();
  }
  private next() {
    this.timer = undefined;
    while (this.queue.length) {
      const total = this.queue.reduce((sum, e) => sum + e.pause, 0);
      const scale = total
        ? Math.min(1, Math.max(0, this.deadline - this.now()) / total)
        : 1;
      const entry = this.queue.shift()!;
      entry.run(scale);
      const delay = entry.pause * scale;
      if (delay > 0) {
        this.timer = setTimeout(() => this.next(), delay);
        return;
      }
    }
  }
  flush() {
    const pending = this.queue;
    this.clear();
    for (const entry of pending) entry.run(0);
  }
  clear() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.queue = [];
  }
}
