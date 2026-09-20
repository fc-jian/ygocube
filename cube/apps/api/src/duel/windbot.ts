import { spawn, ChildProcess } from "child_process";
import fs from "fs";
import { config } from "../config";
import type { DuelBot } from "@ygocube/shared";
import { BOT_CATALOG } from "./bot-catalog";
export { BOT_CATALOG } from "./bot-catalog";
export class WindBots {
  private running = new Map<
    string,
    { child: ChildProcess; timer: NodeJS.Timeout }
  >();
  catalog() {
    return config.windbot.enabled
      ? BOT_CATALOG.map(({ id, name, description, robot }) => ({
          id,
          name,
          description,
          robot,
        }))
      : [];
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
    const selected = BOT_CATALOG.find((b) => b.id === id)!;
    const child = spawn(
      config.windbot.executable,
      [
        ...config.windbot.args,
        `Deck=${id}`,
        `Name=${selected.robot}`,
        `Dialog=${selected.dialog}`,
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
