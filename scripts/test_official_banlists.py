import copy
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from official_banlists import compose, import_sc, validate_snapshot, CATALOG


class OfficialBanlistTests(unittest.TestCase):
    def test_audited_current_sc_snapshot_and_native_composition(self):
        snapshot = json.loads((CATALOG / '2026.10.01-sc.json').read_text(encoding='utf-8'))
        validate_snapshot(snapshot)
        self.assertEqual(snapshot['counts'], {'0': 29, '1': 65, '2': 16, '3': 2})
        limits = {item['code']: item['limit'] for item in snapshot['entries']}
        self.assertEqual(limits[3679218], 0)
        self.assertEqual(limits[30581601], 1)
        self.assertEqual(limits[83764718], 1)
        self.assertNotIn(83764722, limits)
        with tempfile.TemporaryDirectory() as temporary:
            upstream = Path(temporary) / 'lflist.conf'
            upstream.write_text('!2026.10\n03679218 0\n!Custom\n123 2\n', encoding='utf-8')
            text, provenance = compose(upstream)
            self.assertTrue(text.startswith(upstream.read_text(encoding='utf-8')))
            self.assertIn('!2026.10.01 SC\n', text)
            self.assertEqual(len(provenance), 1)
            self.assertEqual(text, compose(upstream)[0])
            upstream.write_text(text, encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'Duplicate SC'):
                compose(upstream)

    def test_invalid_or_incomplete_snapshots_fail_closed(self):
        snapshot = json.loads((CATALOG / '2026.10.01-sc.json').read_text(encoding='utf-8'))
        for change in (lambda d: d['entries'].pop(),
                       lambda d: d['entries'].append(d['entries'][0]),
                       lambda d: d['entries'][0].update(code='03679218'),
                       lambda d: d['entries'][0].update(limit=4)):
            value = copy.deepcopy(snapshot)
            change(value)
            with self.assertRaises(ValueError):
                validate_snapshot(value)

    def test_import_resolves_artworks_but_rejects_ambiguous_names(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            db = sqlite3.connect(root / 'cards.cdb')
            db.execute('CREATE TABLE datas(id INTEGER, alias INTEGER, type INTEGER)')
            db.executemany('INSERT INTO datas VALUES(?,?,?)', [(1, 0, 1), (2, 1, 1), (3, 0, 1), (4, 0, 1)])
            db.commit()
            db.close()
            data = {
                'index': {'code': 0, 'list': [{'id': 35, 'name': '第19次更新：2026/10适用'}]},
                'detail': {'code': 0, 'name': '第19次更新：2026/10适用', 'list': [
                    {'name': '禁止卡 1张', 'list': [{'name': '测试・甲'}]},
                    {'name': '限制卡 1张', 'list': [{'name': '乙'}]},
                    {'name': '准限制卡 1张', 'list': [{'name': '丙'}]},
                ]},
                'names': {'1': {'sc_name': '测试·甲'}, '2': {'sc_name': '测试・甲'}, '3': {'sc_name': '乙'}, '4': {'sc_name': '丙'}},
            }
            def write():
                for key, value in data.items():
                    (root / (key + '.json')).write_text(json.dumps(value), encoding='utf-8')
            def run():
                return import_sc(root / 'index.json', root / 'detail.json', root / 'names.json', root / 'cards.cdb', 35)
            write()
            self.assertEqual([entry['code'] for entry in run()['entries']], [1, 3, 4])
            data['names']['3']['sc_name'] = '测试・甲'
            write()
            with self.assertRaisesRegex(ValueError, 'one native identity'):
                run()


if __name__ == '__main__':
    unittest.main()
