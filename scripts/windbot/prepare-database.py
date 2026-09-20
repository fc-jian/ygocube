#!/usr/bin/env python3
"""Build WindBot's combined CDB without changing production resources."""
import pathlib, sqlite3, sys, shutil, json
base, output, decks = map(pathlib.Path, sys.argv[1:4])
sources = [base, *sorted((base.parent/'expansions').glob('*.cdb'))]
assert output.resolve() not in [p.resolve() for p in sources]
shutil.copy2(base, output)
with sqlite3.connect(output) as dst:
    for source in sources[1:]:
        with sqlite3.connect(f'file:{source}?mode=ro', uri=True) as src:
            for table in ['datas', 'texts']:
                rows = src.execute(f'SELECT * FROM {table}').fetchall()
                if rows: dst.executemany(f'INSERT OR REPLACE INTO {table} VALUES ({",".join("?" for _ in rows[0])})', rows)
    missing = {}
    for file in sorted(decks.glob('*.ydk')):
        name = file.stem
        codes = [int(line) for line in (decks/(name+'.ydk')).read_text(encoding='utf-8-sig').splitlines() if line.strip().isdigit()]
        absent = [code for code in codes if not dst.execute('SELECT 1 FROM datas WHERE id=?',(code,)).fetchone()]
        assert not absent, (name, absent)
    assert dst.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
print(json.dumps({'ok':True,'sources':[str(p) for p in sources],'decks':len(list(decks.glob('*.ydk')))}))
