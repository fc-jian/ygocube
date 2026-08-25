// Unified pre-boot configuration from config.yaml (repo root, env CONFIG_FILE to override).
// See dev_docs/05 §9 for the schema.
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';

export interface AppConfig {
  admin: {
    superToken: string;
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
    stringsConf: string;
    allowedOrigins: string[];
    allowInsecureDefaults: boolean;
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
  const cardsCdb = resolvePath(server.cards_cdb as string | undefined, process.env.CARDS_CDB, 'srvpro/ygopro/cards.cdb');
  const originsRaw = server.allowed_origins ?? process.env.CUBE_ALLOWED_ORIGINS ?? ['http://localhost:3000', 'http://127.0.0.1:3000'];
  const allowedOrigins = Array.isArray(originsRaw)
    ? originsRaw.map(String)
    : String(originsRaw).split(',').map((x) => x.trim()).filter(Boolean);
  const rawYgoproRoot = String(pics.ygopro_root ?? process.env.PICS_YGOPRO_ROOT ?? '').trim();
  return {
    admin: {
      superToken: String(admin.super_token ?? process.env.CUBE_SUPER_TOKEN ?? 'change-me-super-token'),
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
      cardsCdb,
      stringsConf: resolvePath(server.strings_conf as string | undefined, process.env.STRINGS_CONF, path.join(path.dirname(cardsCdb), 'strings.conf')),
      allowedOrigins,
      allowInsecureDefaults: server.allow_insecure_defaults === true || process.env.CUBE_ALLOW_INSECURE_DEFAULTS === '1',
    },
    pics: {
      // Empty disables the original-image proxy. Resolving an empty string
      // would otherwise turn it into the config directory and unintentionally
      // enable filesystem lookups there.
      ygoproRoot: rawYgoproRoot ? resolvePath(rawYgoproRoot, undefined, rawYgoproRoot) : '',
      // low-res avif thumbnails stored server-side (assets/pics_avif), served via GET /pics/:code.avif
      avifDir: resolvePath(pics.avif_dir as string | undefined, process.env.PICS_AVIF_DIR, 'assets/pics_avif'),
    },
  };
}

export const config = loadConfig();

export const defaults = {
  packSize: 24, // 每堆卡牌数（任意正整数，不再要求是人数整数倍）
  packSizeMultiple: 3, // 旧配置兼容（packSize 缺失时每堆 = 人数 × 该倍数）
  draftMode: 'passing', // passing=每玩家牌堆队列传递式；serial=旧全局串行（仅 raw config 可设）
  evenPackCount: true, // 牌堆数须为人数整数倍（显式 packCount 非倍数拒绝；自动计算向下取整）
  reserveSeconds: 400, // passing 模式每玩家保留时间（单选超时先扣 reserve，耗尽才自动选）
  reseatEachRound: true, // passing 每轮结束后随机重排玩家座位（默认开）
  pickSeconds: 40,
  deckbuildingSeconds: null as number | null, // 默认无限；管理员手动进入对战阶段
  extraRatioPercent: null as number | null, // 每堆额外卡比例；null 表示沿用 packStrategy
  mainMin: 40,
  mainMax: 60,
  extraMax: 30,
  sideMax: 30,
  maxCopies: 1,
  timeLimit: 180,
};

export function validateStartupSecurity(): void {
  const bad = new Set(['', 'change-me-super-token']);
  if (!config.server.allowInsecureDefaults && bad.has(config.admin.superToken)) {
    throw new Error('insecure admin token configuration; set a non-placeholder super token or server.allow_insecure_defaults=true');
  }
  if (!config.srvpro.apiKey) throw new Error('srvpro.api_key must not be empty');
  if (!Number.isSafeInteger(config.server.port) || config.server.port < 1 || config.server.port > 65535) {
    throw new Error('server.port must be an integer between 1 and 65535');
  }
  if (!Number.isSafeInteger(config.srvpro.gamePort) || config.srvpro.gamePort < 1 || config.srvpro.gamePort > 65535) {
    throw new Error('srvpro.game_port must be an integer between 1 and 65535');
  }
  if (config.server.allowedOrigins.length === 0 || config.server.allowedOrigins.some((origin) => {
    try {
      const parsed = new URL(origin);
      return parsed.origin !== origin || !['http:', 'https:'].includes(parsed.protocol);
    } catch {
      return true;
    }
  })) {
    throw new Error('server.allowed_origins must contain exact http(s) origins without paths or trailing slashes');
  }
}
