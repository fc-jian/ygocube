import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import {
  extractStaticAssetUrls,
  resolveStaticAssetPath,
  standaloneStaticDir,
  validateStandaloneStatic,
} from '../lib/standaloneRelease.mjs';
import { prepareStandaloneAssets } from '../scripts/prepare-standalone.mjs';

async function fixture() {
  // The development shell may inherit a Windows TMPDIR mounted read-only in
  // WSL; use the repository test convention's writable Linux temp directory.
  const root = await mkdtemp('/tmp/ygocube-web-');
  const staticDir = standaloneStaticDir(root);
  await mkdir(path.join(staticDir, 'chunks', 'app'), { recursive: true });
  await writeFile(path.join(staticDir, 'chunks', 'runtime.js'), 'runtime');
  await writeFile(path.join(staticDir, 'chunks', 'app', 'page.js'), 'page');
  return { root, staticDir };
}

test('standalone static directory uses the nested apps/web layout', async () => {
  const root = '/tmp/release';
  assert.equal(standaloneStaticDir(root), '/tmp/release/apps/web/.next/static');
});

test('reports then accepts static assets with encoded route brackets', async () => {
  const { root } = await fixture();
  try {
    const staticDir = standaloneStaticDir(root);
    const html = [
      '<script src="/_next/static/chunks/runtime.js"></script>',
      '<script src="/_next/static/chunks/app/page.js"></script>',
      '<script src="/_next/static/chunks/app/t/%5Btid%5D.js"></script>',
    ].join('');
    const result = validateStandaloneStatic({ standaloneRoot: root, html });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['/_next/static/chunks/app/t/%5Btid%5D.js']);

    await mkdir(path.join(staticDir, 'chunks', 'app', 't'), { recursive: true });
    await writeFile(path.join(staticDir, 'chunks', 'app', 't', '[tid].js'), 'route');
    const encodedHtml = '<script src="/_next/static/chunks/app/t/%5Btid%5D.js"></script>';
    const encodedResult = validateStandaloneStatic({ standaloneRoot: root, html: encodedHtml });
    assert.equal(encodedResult.ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reports a missing static directory instead of treating a 200 HTML page as healthy', async () => {
  const root = await mkdtemp('/tmp/ygocube-web-empty-');
  try {
    const result = validateStandaloneStatic({
      standaloneRoot: root,
      html: '<script src="/_next/static/chunks/runtime.js"></script>',
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'MISSING_NEXT_STATIC');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects static URL path traversal', async () => {
  const { root, staticDir } = await fixture();
  try {
    assert.throws(
      () => resolveStaticAssetPath(staticDir, '/_next/static/%2e%2e/%2e%2e/secret.js'),
      /NEXT_STATIC_PATH_TRAVERSAL/,
    );
    const result = validateStandaloneStatic({
      standaloneRoot: root,
      html: '<script src="/_next/static/%2e%2e/%2e%2e/secret.js"></script>',
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['/_next/static/%2e%2e/%2e%2e/secret.js']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('extracts and de-duplicates only Next static src/href references', () => {
  const html = [
    '<script src="/_next/static/chunks/a.js"></script>',
    '<script src="/_next/static/chunks/a.js"></script>',
    '<link href="/_next/static/css/a.css" rel="stylesheet">',
    '<img src="/images/card.png">',
  ].join('');
  assert.deepEqual(extractStaticAssetUrls(html), [
    '/_next/static/chunks/a.js',
    '/_next/static/css/a.css',
  ]);
});

test('postbuild copies static and public assets into the standalone app', async () => {
  const root = await mkdtemp('/tmp/ygocube-web-prepare-');
  try {
    const nextDir = path.join(root, '.next');
    const standaloneAppDir = path.join(nextDir, 'standalone', 'apps', 'web');
    const publicDir = path.join(root, 'public');
    await mkdir(path.join(nextDir, 'static', 'chunks'), { recursive: true });
    await mkdir(publicDir, { recursive: true });
    await writeFile(path.join(nextDir, 'static', 'chunks', 'runtime.js'), 'runtime');
    await writeFile(path.join(publicDir, 'robots.txt'), 'User-agent: *');

    const result = await prepareStandaloneAssets({ nextDir, standaloneAppDir, publicDir });
    assert.equal(result.copiedPublic, true);
    assert.equal(await readFile(path.join(result.staticDestination, 'chunks', 'runtime.js'), 'utf8'), 'runtime');
    assert.equal(await readFile(path.join(result.publicDestination, 'robots.txt'), 'utf8'), 'User-agent: *');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('postbuild removes a stale public directory when the source has none', async () => {
  const root = await mkdtemp('/tmp/ygocube-web-prepare-empty-');
  try {
    const nextDir = path.join(root, '.next');
    const standaloneAppDir = path.join(nextDir, 'standalone', 'apps', 'web');
    await mkdir(path.join(nextDir, 'static'), { recursive: true });
    await mkdir(path.join(standaloneAppDir, 'public'), { recursive: true });
    await writeFile(path.join(nextDir, 'static', 'runtime.js'), 'runtime');
    await writeFile(path.join(standaloneAppDir, 'public', 'stale.txt'), 'stale');

    const result = await prepareStandaloneAssets({ nextDir, standaloneAppDir });
    assert.equal(result.copiedPublic, false);
    await assert.rejects(access(result.publicDestination));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
