import { spawn, ChildProcess } from "child_process";
import fs from "fs";
import { config } from "../config";
import type { DuelBot } from "@ygocube/shared";
export const BOT_CATALOG: DuelBot[] = [
  {
    id: "Blue-Eyes",
    name: "青眼白龙",
    description: "以高攻击力龙族展开，适合熟悉基本对战。",
  },
  {
    id: "DarkMagician",
    name: "黑魔术师",
    description: "通过魔法陷阱配合展开与干扰。",
  },
  {
    id: "Altergeist",
    name: "幻变骚灵",
    description: "陷阱与怪兽效果连锁，练习应对干扰。",
  },
  { id: "Burn", name: "效果伤害", description: "以效果伤害为主的练习对手。" },
];
export class WindBots {
  private running = new Map<
    string,
    { child: ChildProcess; timer: NodeJS.Timeout }
  >();
  catalog() {
    return config.windbot.enabled ? BOT_CATALOG : [];
  }
  check(id: unknown) {
    if (!config.webDuel.enabled || !config.windbot.enabled)
      throw new Error("BOT_DISABLED");
    if (!BOT_CATALOG.some((b) => b.id === id)) throw new Error("BAD_PAYLOAD");
    if (this.running.size >= config.windbot.maxProcesses)
      throw new Error("BOT_BUSY");
    if (
      !fs.existsSync(config.windbot.executable) ||
      !fs.existsSync(config.windbot.database)
    )
      throw new Error("BOT_FAILED");
  }
  start(
    room: string,
    id: string,
    failed: () => void,
    connected: () => boolean = () => true,
  ) {
    if (this.running.has(room)) return;
    this.check(id);
    if (!/^W[a-f0-9]{18}$/.test(room)) throw new Error("BAD_PAYLOAD");
    const child = spawn(
      config.windbot.executable,
      [
        ...config.windbot.args,
        `Deck=${id}`,
        "Name=机器人",
        `Host=${config.webDuel.upstreamHost}`,
        `Port=${config.srvpro.gamePort}`,
        `HostInfo=${room}`,
        `Version=${config.webDuel.version}`,
        `DbPath=${config.windbot.database}`,
        "Chat=False",
        "Debug=False",
        "ServerMode=False",
      ],
      {
        cwd: config.windbot.cwd,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    // Drain bounded output: never let a noisy bot exhaust API memory.
    let diagnostic = "";
    for (const stream of [child.stdout, child.stderr])
      stream?.on("data", (b) => {
        diagnostic = (diagnostic + b.toString()).slice(-2048);
      });
    const started = Date.now();
    let lastConnected = started;
    const timer = setInterval(() => {
      if (connected()) lastConnected = Date.now();
      if (
        Date.now() - lastConnected >= 30 * 60 * 1000 ||
        Date.now() - started >= 2 * 60 * 60 * 1000
      )
        child.kill();
    }, 30000);
    timer.unref();
    this.running.set(room, { child, timer });
    let done = false;
    const finish = (error: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      this.running.delete(room);
      if (error) {
        console.error("WindBot failed", diagnostic);
        failed();
      }
    };
    child.once("error", () => finish(true));
    child.once("exit", (code) =>
      finish(
        code !== 0 ||
          /Run Error|Could not|Unhandled Exception/.test(diagnostic),
      ),
    );
  }
  close() {
    for (const { child, timer } of this.running.values()) {
      clearTimeout(timer);
      child.kill();
    }
    this.running.clear();
  }
}
