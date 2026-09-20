// Verify every catalog entry against the actual WindBot runtime using a local protocol peer.
const net = require("node:net"),
  fs = require("node:fs"),
  assert = require("node:assert/strict"),
  { spawn } = require("node:child_process");
const [root, database, catalogPath] = process.argv.slice(2);
const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
const packet = (op, data) => {
  const b = Buffer.alloc(data.length + 3);
  b.writeUInt16LE(data.length + 1);
  b[2] = op;
  data.copy(b, 3);
  return b;
};
(async () => {
  for (const bot of catalog) {
    await new Promise((resolve, reject) => {
      let child,
        sock,
        timer,
        buffer = Buffer.alloc(0),
        ready = false,
        deck = false,
        log = "",
        settled = false;
      const server = net.createServer((s) => {
        sock = s;
        s.on("error", reject);
        s.on("data", (b) => {
          buffer = Buffer.concat([buffer, b]);
          while (
            buffer.length >= 3 &&
            buffer.length >= buffer.readUInt16LE(0) + 2
          ) {
            const f = buffer.subarray(0, buffer.readUInt16LE(0) + 2);
            buffer = buffer.subarray(f.length);
            if (f[2] === 0x12) {
              const host = Buffer.alloc(20);
              host[6] = 5;
              s.write(packet(0x12, host));
              s.write(packet(0x13, Buffer.from([1])));
            }
            if (f[2] === 2) {
              assert(f.length >= 11);
              const n = f.readUInt32LE(3),
                side = f.readUInt32LE(7);
              assert(n >= 40 && n <= 75 && side <= 15, bot.id + ": deck size");
              assert.equal(f.length, 11 + (n + side) * 4);
              deck = true;
            }
            if (f[2] === 0x22) ready = true;
            if (deck && ready) s.end();
          }
        });
      });
      const done = (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock?.destroy();
        server.close();
        child?.kill();
        e ? reject(e) : resolve();
      };
      server.listen(0, "127.0.0.1", () => {
        child = spawn(
          root + "/run-windbot",
          [
            `Name=${bot.robot}`,
            `Deck=${bot.id}`,
            `Dialog=${bot.dialog}`,
            `DbPath=${database}`,
            "Host=127.0.0.1",
            `Port=${server.address().port}`,
            "Version=4962",
            "Chat=False",
            "Debug=False",
          ],
          { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
        );
        child.stdout.on("data", (b) => {
          log = (log + b).slice(-3000);
        });
        child.stderr.on("data", (b) => {
          log = (log + b).slice(-3000);
        });
        child.on("error", done);
        child.on("exit", (code) =>
          done(code === 0 && deck && ready ? null : Error(bot.id + ": " + log)),
        );
        timer = setTimeout(
          () => done(Error("timeout " + bot.id + ": " + log)),
          15000,
        );
      });
    });
    console.log("PASS " + bot.robot + " / " + bot.id);
  }
  console.log(
    JSON.stringify({
      ok: true,
      robots: new Set(catalog.map((b) => b.robot)).size,
      decks: catalog.length,
    }),
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
