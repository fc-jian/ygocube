import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('Linux keeps standalone releases while Windows can build without symlink privileges', () => {
  const url = new URL('../next.config.mjs', import.meta.url).href;
  for (const [platform, flag, output] of [
    ['linux', '', 'standalone'], ['win32', '', null],
    ['win32', '1', 'standalone'], ['linux', '0', null],
  ]) {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e',
      `Object.defineProperty(process, 'platform', {value: ${JSON.stringify(platform)}}); const {default: c} = await import(${JSON.stringify(url)}); console.log(JSON.stringify({output: c.output ?? null, distDir: c.distDir}));`,
    ], {encoding: 'utf8', windowsHide: true, env: {...process.env, NEXT_STANDALONE: flag, NEXT_DIST_DIR: '.next-test-profile'}});
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), {output, distDir: '.next-test-profile'});
  }
});
