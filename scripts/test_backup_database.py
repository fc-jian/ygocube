import importlib.util
from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('backup_database', Path(__file__).with_name('backup-database.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BackupTests(unittest.TestCase):
    def test_wal_backup_restore_mirror_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, destination = root / 'live.sqlite', root / 'backup.sqlite'
            with closing(sqlite3.connect(source)) as live:
                live.execute('PRAGMA journal_mode=WAL')
                live.execute('CREATE TABLE scores(id INTEGER PRIMARY KEY, value INTEGER)')
                live.execute('INSERT INTO scores VALUES(1,2)'); live.commit()
                result = module.backup(source, destination, root / 'mirror')
                self.assertTrue(result['restoreVerified'])
                self.assertEqual(module.verify(destination), module.verify(root / 'mirror/backup.sqlite'))
                with closing(sqlite3.connect(destination)) as restored:
                    self.assertEqual(restored.execute('SELECT value FROM scores').fetchall(), [(2,)])
                with self.assertRaises(ValueError): module.backup(source, destination)

    def test_invalid_source_does_not_publish_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'broken').write_bytes(b'not sqlite')
            with self.assertRaises(sqlite3.DatabaseError): module.backup(root / 'broken', root / 'backup')
            self.assertFalse((root / 'backup.json').exists())
