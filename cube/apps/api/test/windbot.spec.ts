import { WindBots, BOT_CATALOG } from "../src/duel/windbot";
import { config } from "../src/config";
import fs from "fs";
import { EventEmitter } from "events";
import { spawn } from "child_process";
jest.mock("child_process", () => ({ spawn: jest.fn() }));
describe("WindBot process boundaries", () => {
  const old = { ...config.windbot },
    enabled = config.webDuel.enabled;
  let manager: WindBots;
  beforeEach(() => {
    jest.useFakeTimers();
    config.webDuel.enabled = true;
    Object.assign(config.windbot, {
      enabled: true,
      executable: "bot.exe",
      args: [],
      cwd: ".",
      database: "cards.cdb",
      maxProcesses: 1,
    });
    jest.spyOn(fs, "existsSync").mockReturnValue(true);
    (spawn as jest.Mock).mockImplementation(() =>
      Object.assign(new EventEmitter(), {
        kill: jest.fn(),
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      }),
    );
    manager = new WindBots();
  });
  afterEach(() => {
    manager.close();
    jest.restoreAllMocks();
    jest.clearAllMocks();
    jest.useRealTimers();
    Object.assign(config.windbot, old);
    config.webDuel.enabled = enabled;
  });
  it("covers all bundled decks with the configured character and dialog", () => {
    expect(BOT_CATALOG).toHaveLength(70);
    expect(new Set(BOT_CATALOG.map((b) => b.id)).size).toBe(70);
    expect(new Set(BOT_CATALOG.map((b) => b.robot)).size).toBe(24);
    expect(BOT_CATALOG.find((b) => b.id === "Blue-Eyes")).toMatchObject({
      robot: "复制植物",
      dialog: "copy.zh-CN",
    });
    expect(BOT_CATALOG.find((b) => b.id === "MalissOCG")).toMatchObject({
      robot: "今晚有宵夜吗",
      dialog: "Xiaoye.zh-CN",
    });
    expect(manager.catalog().every((b) => b.robot)).toBe(true);
    manager.start("W123456789012345678", "Level VIII", jest.fn());
    expect((spawn as jest.Mock).mock.calls[0][1]).toEqual(
      expect.arrayContaining([
        "Deck=Level VIII",
        "Name=谜之剑士LV4",
        "Dialog=swordsman.zh-CN",
      ]),
    );
  });
  it("rejects disabled instances and untrusted deck or room paths", () => {
    config.windbot.enabled = false;
    expect(() => manager.check("Blue-Eyes")).toThrow("BOT_DISABLED");
    config.windbot.enabled = true;
    expect(() => manager.check("../DeckFile=x")).toThrow("BAD_PAYLOAD");
    expect(() => manager.start("x;touch", "Burn", jest.fn())).toThrow(
      "BAD_PAYLOAD",
    );
    expect(spawn).not.toHaveBeenCalled();
  });
  it("starts once per room and releases capacity on exit", () => {
    const room = "W123456789012345678",
      failed = jest.fn();
    manager.start(room, "Blue-Eyes", failed);
    manager.start(room, "Blue-Eyes", failed);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect((spawn as jest.Mock).mock.calls[0][2].shell).toBe(false);
    expect(() => manager.check("Burn")).toThrow("BOT_BUSY");
    (spawn as jest.Mock).mock.results[0].value.emit("exit", 1);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(() => manager.check("Burn")).not.toThrow();
  });
  it("keeps connected games unlimited and stops disconnected bots", () => {
    const failed = jest.fn();
    let connected = true;
    manager.start("W123456789012345678", "Burn", failed, () => connected);
    const child = (spawn as jest.Mock).mock.results[0].value;
    jest.advanceTimersByTime(2 * 60 * 60 * 1000);
    expect(child.kill).not.toHaveBeenCalled();
    connected = false;
    jest.advanceTimersByTime(1000);
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.emit("error", new Error("ENOENT"));
    child.emit("exit", 1);
    expect(failed).not.toHaveBeenCalled();
  });
  it("reports spawn errors only once", () => {
    const failed = jest.fn();
    manager.start("W123456789012345678", "Burn", failed);
    const child = (spawn as jest.Mock).mock.results[0].value;
    child.emit("error", new Error("ENOENT"));
    child.emit("exit", 1);
    expect(failed).toHaveBeenCalledTimes(1);
  });
});
