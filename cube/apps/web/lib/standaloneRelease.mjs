import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const STATIC_PREFIX = '/_next/static/';

/**
 * Resolve the static directory produced alongside a Next standalone build.
 * Next keeps the app under standalone/apps/web, so copying only standalone
 * leaves this directory absent and every browser chunk becomes a 404.
 */
export function standaloneStaticDir(standaloneRoot) {
  return path.join(path.resolve(standaloneRoot), 'apps', 'web', '.next', 'static');
}

export function listStaticFiles(staticDir) {
  const root = path.resolve(staticDir);
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];

  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile()) files.push(path.relative(root, entryPath));
    }
  };
  visit(root);
  return files.sort();
}

export function extractStaticAssetUrls(html) {
  const urls = new Set();
  const pattern = /(?:src|href)=["'](\/_next\/static\/[^"']+)["']/g;
  for (const match of html.matchAll(pattern)) urls.add(match[1]);
  return [...urls].sort();
}

export function resolveStaticAssetPath(staticDir, url) {
  if (!url.startsWith(STATIC_PREFIX)) throw new Error(`NOT_NEXT_STATIC: ${url}`);
  let relative;
  try {
    relative = decodeURIComponent(url.slice(STATIC_PREFIX.length));
  } catch {
    throw new Error(`BAD_NEXT_STATIC_URL: ${url}`);
  }

  const root = path.resolve(staticDir);
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`NEXT_STATIC_PATH_TRAVERSAL: ${url}`);
  }
  return resolved;
}

/**
 * Validate the filesystem portion of a standalone Web release against page
 * HTML. This is intentionally independent of HTTP so it can run in CI and
 * before an Aly release is switched live.
 */
export function validateStandaloneStatic({ standaloneRoot, html }) {
  const staticDir = standaloneStaticDir(standaloneRoot);
  const staticFiles = listStaticFiles(staticDir);
  if (staticFiles.length === 0) {
    return { ok: false, staticDir, staticFiles, assets: [], missing: [], error: 'MISSING_NEXT_STATIC' };
  }

  const assets = extractStaticAssetUrls(html);
  const missing = [];
  for (const url of assets) {
    try {
      const assetPath = resolveStaticAssetPath(staticDir, url);
      if (!existsSync(assetPath) || !statSync(assetPath).isFile()) missing.push(url);
    } catch {
      missing.push(url);
    }
  }
  return { ok: missing.length === 0, staticDir, staticFiles, assets, missing };
}
