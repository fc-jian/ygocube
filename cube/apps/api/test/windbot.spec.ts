import { WindBots } from "../src/duel/windbot";
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
  it("bounds process lifetime and handles spawn errors exactly once", () => {
    const failed = jest.fn();
    manager.start("W123456789012345678", "Burn", failed);
    const child = (spawn as jest.Mock).mock.results[0].value;
    jest.advanceTimersByTime(2 * 60 * 60 * 1000);
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.emit("error", new Error("ENOENT"));
    child.emit("exit", 1);
    expect(failed).toHaveBeenCalledTimes(1);
  });
});
