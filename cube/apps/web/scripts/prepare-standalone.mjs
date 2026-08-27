import { access, cp, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function replaceDirectory(source, destination, label) {
  if (!(await pathExists(source))) throw new Error(`Missing ${label} directory: ${source}`);
  await mkdir(path.dirname(destination), { recursive: true });
  const stage = `${destination}.stage-${process.pid}-${Date.now()}`;
  await rm(stage, { recursive: true, force: true });
  try {
    await cp(source, stage, { recursive: true });
    await rm(destination, { recursive: true, force: true });
    await rename(stage, destination);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/**
 * Make Next's standalone output self-contained for deployment. Next leaves
 * .next/static (and public, when present) beside standalone rather than
 * inside it, so a release that copies only standalone serves HTML but 404s
 * every browser chunk.
 */
export async function prepareStandaloneAssets({ nextDir, standaloneAppDir, publicDir }) {
  const staticSource = path.join(nextDir, 'static');
  const staticDestination = path.join(standaloneAppDir, '.next', 'static');
  await replaceDirectory(staticSource, staticDestination, '.next/static');

  const publicDestination = path.join(standaloneAppDir, 'public');
  const copiedPublic = publicDir ? await pathExists(publicDir) : false;
  if (copiedPublic) await replaceDirectory(publicDir, publicDestination, 'public');
  else await rm(publicDestination, { recursive: true, force: true });

  return { staticDestination, publicDestination, copiedPublic };
}

async function main() {
  const appRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const nextDir = path.join(appRoot, '.next');
  const result = await prepareStandaloneAssets({
    nextDir,
    standaloneAppDir: path.join(nextDir, 'standalone', 'apps', 'web'),
    publicDir: path.join(appRoot, 'public'),
  });
  console.log(`Prepared ${result.staticDestination}`);
  if (result.copiedPublic) console.log(`Prepared ${result.publicDestination}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
