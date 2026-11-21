"""Isolated regression checks for the standalone Aly application installer."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tarfile
import tempfile
import unittest
from types import SimpleNamespace


class ApplicationCandidateTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        source = Path(__file__).with_name('deploy-card-details.py').read_text(encoding='utf-8')
        functions = source[source.index('def verify_tree('):source.index('def build_candidate(')]
        self.checks = []
        self.scope = dict(P=Path, os=os, json=json, tarfile=tarfile, tempfile=tempfile,
                          sha=lambda path: hashlib.sha256(path.read_bytes()).hexdigest(),
                          a=SimpleNamespace(release='fixture', web_only=True),
                          run=lambda *args: self.checks.append(args))
        exec(compile(functions, 'application-candidate', 'exec'), self.scope)
        self.stage = self.root / '.staging/fixture'

    def create_archive(self, build_id):
        web = 'ygocube/web/standalone/apps/web/.next/'
        contents = {web + 'BUILD_ID': build_id, web + 'static/app.js': build_id,
                    web + 'server/manifest.json': '{}'}
        manifest = dict(format=2, sourceCommit='same-commit', links={},
                        files={name: hashlib.sha256(data.encode()).hexdigest() for name, data in contents.items()})
        contents['manifest.json'] = json.dumps(manifest)
        archive = self.root / (build_id + '.tgz')
        with tempfile.TemporaryDirectory() as temp, tarfile.open(archive, 'w:gz') as bundle:
            for name, data in contents.items():
                path = Path(temp) / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data.encode())
                bundle.add(path, arcname=name)
        return archive, self.scope['sha'](archive)

    def test_retry_rejects_different_archive_at_same_commit_and_detects_stage_drift(self):
        archive, digest = self.create_archive('first')
        stage = self.scope['stage_archive']
        stage(archive, digest, self.stage)
        stage(archive, digest, self.stage)
        other, other_digest = self.create_archive('second')
        with self.assertRaisesRegex(ValueError, 'another archive'):
            stage(other, other_digest, self.stage)
        nested = next(self.stage.rglob('server/manifest.json'))
        nested.write_text('changed')
        with self.assertRaisesRegex(ValueError, 'file differs'):
            stage(archive, digest, self.stage)

    def test_reused_candidate_requires_matching_metadata_exact_files_and_runtime_smoke(self):
        archive, digest = self.create_archive('first')
        manifest = self.scope['stage_archive'](archive, digest, self.stage)
        candidate = self.root / 'candidate'
        shutil.copytree(self.stage / 'ygocube', candidate)
        (candidate / 'COMMIT').write_text('same-commit')
        receipt = dict(id='fixture', sourceCommit='same-commit', artifactSha256=digest, installMode='web', webBuildId='first')
        (candidate / 'release.json').write_text(json.dumps(receipt))
        verify = self.scope['verify_candidate']
        for _ in range(2):
            verify('ygocube', candidate, manifest, digest, 'web')
        self.assertEqual(len(self.checks), 2)
        with self.assertRaisesRegex(ValueError, 'installMode'):
            verify('ygocube', candidate, manifest, digest, 'api-web')
        with self.assertRaisesRegex(ValueError, 'artifactSha256'):
            verify('ygocube', candidate, manifest, 'different', 'web')
        (candidate / 'web/stale.js').touch()
        with self.assertRaisesRegex(ValueError, 'file set differs'):
            verify('ygocube', candidate, manifest, digest, 'web')


@unittest.skipIf(os.name == 'nt', 'Linux release bundle uses POSIX links')
class PackageLinksTest(unittest.TestCase):
    def test_bundle_accepts_local_links_and_rejects_source_tree_or_missing_targets(self):
        module = Path(__file__).with_name('package-app-release.py')
        spec = importlib.util.spec_from_file_location('app_packager', module)
        packager = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(packager)
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            bundle = workspace / 'bundle'
            bundle.mkdir()
            (workspace / 'source').touch()
            (bundle / 'installed').touch()
            link = bundle / 'linked'
            link.symlink_to('installed')
            self.assertEqual(packager.inventory(bundle)[1], {'linked': 'installed'})
            for target in ('../source', 'missing'):
                link.unlink()
                link.symlink_to(target)
                with self.assertRaisesRegex(ValueError, 'Nonportable link'):
                    packager.inventory(bundle)
