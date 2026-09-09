// Native local development on Windows and Linux. No production services are touched.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const yaml = require(path.join(root, 'cube/apps/api/node_modules/yaml'));
const duel = process.argv.includes('--duel');
const profile = duel ? 'duel' : 'cube';
const runtime = path.join(root, 'data/local-dev', profile);
const webPort = Number(process.env.LOCAL_WEB_PORT || (duel ? 3100 : (process.platform === 'win32' ? 3200 : 3000))), apiPort = webPort + 1;
const gamePort = duel ? 17911 : 7911, httpPort = duel ? 17922 : 7922;
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.pid || child.exitCode !== null) continue;
    if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
    else { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
  }
  process.exit(code);
}
function linkOrCopy(source, target) {
  if (fs.existsSync(target) && fs.statSync(source).isDirectory()) return;
  if (fs.statSync(source).isDirectory()) fs.symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
  else fs.copyFileSync(source, target);
}
function child(label, args, cwd, env) {
  const log = fs.openSync(path.join(runtime, label + '.log'), 'a');
  const p = spawn(process.execPath, args, {cwd, env: {...process.env, ...env}, stdio: ['ignore', log, log], windowsHide: true, detached: process.platform !== 'win32'});
  fs.closeSync(log);
  children.push(p);
  p.on('error', e => {console.error(label, e); stop(1);});
  p.on('exit', code => {if (!stopping) {console.error(`${label} exited (${code}); see ${runtime}`); stop(code || 1);}});
}
async function freePort(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen({port, host: '127.0.0.1', exclusive: true}, resolve);});
  await new Promise(resolve => server.close(resolve));
}
async function ready(url) {
  const deadline = Date.now() + 120000;
  let lastError = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {signal: AbortSignal.timeout(10000)});
      await response.body?.cancel();
      if (response.ok) return;
      lastError = 'HTTP ' + response.status;
    } catch (error) { lastError = error.message; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw Error(`Service did not become ready: ${url}: ${lastError}; logs: ${runtime}`);
}
(async () => {
  await Promise.all([webPort, apiPort, gamePort, httpPort].map(freePort));
  fs.mkdirSync(runtime, {recursive: true});
  const configPath = path.resolve(process.env.CONFIG_FILE || path.join(root, 'config.yaml'));
  const configRoot = path.dirname(configPath);
  const config = yaml.parse(fs.readFileSync(configPath, 'utf8'));
  const absolute = value => path.resolve(configRoot, value);
  config.server ||= {};
  for (const [key, value] of Object.entries({db_path: 'data/cube.sqlite', cards_cdb: 'srvpro/ygopro/cards.cdb', card_names_json: 'assets/ygocdb_cards.json', strings_conf: 'srvpro/ygopro/strings.conf'})) config.server[key] = absolute(config.server[key] || value);
  // Cube uses the migrated database; standalone development owns a separate database.
  if (duel) config.server.db_path = path.join(runtime, 'duel.sqlite');
  config.server.port = apiPort;
  config.server.host = '127.0.0.1';
  config.server.allow_insecure_defaults = true;
  config.server.allowed_origins = [`http://localhost:${webPort}`, `http://127.0.0.1:${webPort}`];
  config.pics ||= {};
  config.pics.avif_dir = absolute(config.pics.avif_dir || 'assets/pics_avif');
  if (config.pics.ygopro_root) config.pics.ygopro_root = absolute(config.pics.ygopro_root);
  config.srvpro = {...config.srvpro, url: `http://127.0.0.1:${httpPort}`, host: '127.0.0.1', game_port: gamePort};
  config.web_duel = {...config.web_duel, enabled: duel, archive_dir: path.join(runtime, 'archives'), upstream_host: '127.0.0.1', public_url: duel ? `http://localhost:${webPort}/duel` : '', native_host: '127.0.0.1', native_port: gamePort};
  const localConfig = path.join(runtime, 'config.yaml');
  fs.writeFileSync(localConfig, yaml.stringify(config));
  const serverDir = path.join(runtime, 'srvpro');
  fs.mkdirSync(path.join(serverDir, 'config'), {recursive: true});
  fs.mkdirSync(path.join(serverDir, 'ygopro'), {recursive: true});
  for (const name of fs.readdirSync(path.join(root, 'srvpro'))) {
    if (['.git', 'config', 'ygopro'].includes(name)) continue;
    linkOrCopy(path.join(root, 'srvpro', name), path.join(serverDir, name));
  }
  for (const name of fs.readdirSync(path.join(root, 'srvpro/ygopro'))) {
    if (['replay', 'deck', process.platform === 'win32' ? 'ygopro' : 'ygopro.exe'].includes(name)) continue;
    linkOrCopy(path.join(root, 'srvpro/ygopro', name), path.join(serverDir, 'ygopro', name));
  }
  fs.writeFileSync(path.join(serverDir, 'config/config.json'), JSON.stringify({
    port: gamePort, bind_address: '127.0.0.1', version: 4962,
    modules: {http: {port: httpPort}, cube: {enabled: true, api_key: config.srvpro.api_key, webhook_url: `http://127.0.0.1:${apiPort}/cube/result`, web_public_url: config.web_duel.public_url, web_native_host: '127.0.0.1', web_native_port: gamePort}, random_duel: {enabled: false}, cloud_replay: {enabled: false}, reconnect: {enabled: true, allow_kick_reconnect: true}, max_mem_percentage: 100},
  }, null, 2));
  const env = {CONFIG_FILE: localConfig, CUBE_API_URL: `http://127.0.0.1:${apiPort}`, NEXT_DIST_DIR: `.next-${profile}`, NEXT_ASSET_PREFIX: ''};
  if (process.platform === 'linux') env.LD_LIBRARY_PATH = [path.join(root, 'envs/ygocube/lib'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  child('srvpro', [path.join(serverDir, 'ygopro-server.js')], serverDir, env);
  child('api', [path.join(root, 'cube/apps/api/dist/main.js')], root, env);
  const webRoot = path.join(root, 'cube/apps/web');
  child('web', [require.resolve('next/dist/bin/next', {paths: [webRoot]}), 'dev', '-H', '127.0.0.1', '-p', String(webPort)], webRoot, env);
  fs.writeFileSync(path.join(runtime, 'processes.json'), JSON.stringify({supervisor: process.pid, children: children.map(p => p.pid), root, profile}));
  await ready(`http://127.0.0.1:${apiPort}/health`);
  await ready(`http://127.0.0.1:${webPort}${duel ? '/duel' : '/'}`);
  console.log(`Ready: http://127.0.0.1:${webPort}${duel ? '/duel' : '/'}; native TCP ${gamePort}; logs: ${runtime}`);
})().catch(e => {console.error(e); stop(1);});
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
