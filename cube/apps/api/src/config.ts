// Unified pre-boot configuration from config.yaml (repo root, env CONFIG_FILE to override).
// See dev_docs/05 §9 for the schema.
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';

export interface AppConfig {
  admin: {
    superToken: string;
    createToken: string;
  };
  srvpro: {
    url: string;
    apiKey: string;
    host: string;
    gamePort: number;
  };
  server: {
    port: number;
    dbPath: string;
    cardsCdb: string;
  };
  pics: {
    ygoproRoot: string;
    avifDir: string;
  };
}

function resolveDefault(): string {
  const envPath = process.env.CONFIG_FILE;
  if (envPath) return envPath;
  const candidates = [
    path.join(__dirname, '..', '..', '..', '..', 'config.yaml'), // repo root
    path.join(process.cwd(), 'config.yaml'),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
}

function loadConfig(): AppConfig {
  const file = resolveDefault();
  let raw: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      raw = YAML.parse(fs.readFileSync(file, 'utf8')) ?? {};
    } catch (e) {
      console.warn(`config.yaml parse failed (${file}):`, (e as Error).message);
    }
  } else {
    console.warn(`config.yaml not found at ${file}; using defaults`);
  }
  const admin = (raw.admin ?? {}) as Record<string, unknown>;
  const srvpro = (raw.srvpro ?? {}) as Record<string, unknown>;
  const server = (raw.server ?? {}) as Record<string, unknown>;
  const pics = (raw.pics ?? {}) as Record<string, unknown>;
  // resolve relative paths against the config file's directory
  const base = path.dirname(file);
  const resolvePath = (v: string | undefined, envV: string | undefined, fallback: string): string => {
    const rawValue = v ?? envV ?? fallback;
    return path.isAbsolute(rawValue) ? rawValue : path.resolve(base, rawValue);
  };
  return {
    admin: {
      superToken: String(admin.super_token ?? process.env.CUBE_SUPER_TOKEN ?? 'change-me-super-token'),
      createToken: String(admin.create_token ?? process.env.CUBE_CREATE_TOKEN ?? 'change-me-create-token'),
    },
    srvpro: {
      url: String(srvpro.url ?? process.env.SRVPRO_URL ?? 'http://127.0.0.1:7922'),
      apiKey: String(srvpro.api_key ?? process.env.SRVPRO_API_KEY ?? ''),
      host: String(srvpro.host ?? process.env.SRVPRO_HOST ?? '127.0.0.1'),
      gamePort: Number(srvpro.game_port ?? process.env.SRVPRO_GAME_PORT ?? 7911),
    },
    server: {
      port: Number(server.port ?? process.env.PORT ?? 3001),
      dbPath: resolvePath(server.db_path as string | undefined, process.env.DB_PATH, 'data/cube.sqlite'),
      cardsCdb: resolvePath(server.cards_cdb as string | undefined, process.env.CARDS_CDB, '../../srvpro/ygopro/cards.cdb'),
    },
    pics: {
      ygoproRoot: resolvePath(pics.ygopro_root as string | undefined, process.env.PICS_YGOPRO_ROOT, ''),
      // low-res avif thumbnails stored server-side (assets/pics_avif), served via GET /pics/:code.avif
      avifDir: resolvePath(pics.avif_dir as string | undefined, process.env.PICS_AVIF_DIR, 'assets/pics_avif'),
    },
  };
}

export const config = loadConfig();

export const defaults = {
  packSize: 12, // 每堆卡牌数（任意正整数，不再要求是人数整数倍）
  packSizeMultiple: 3, // 旧配置兼容（packSize 缺失时每堆 = 人数 × 该倍数）
  draftMode: 'passing', // passing=每玩家牌堆队列传递式；serial=旧全局串行（仅 raw config 可设）
  evenPackCount: true, // 牌堆数须为人数整数倍（显式 packCount 非倍数拒绝；自动计算向下取整）
  reserveSeconds: 300, // passing 模式每玩家保留时间（单选超时先扣 reserve，耗尽才自动选）
  pickSeconds: 30,
  pauseSeconds: 300,
  deckbuildingSeconds: 600,
  mainMin: 40,
  mainMax: 60,
  extraMax: 30,
  sideMax: 30,
  maxCopies: 1,
  timeLimit: 180,
};
