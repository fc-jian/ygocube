#!/usr/bin/env python3
"""Build the Guess the Card pool and review files from frozen evidence snapshots."""

import argparse
import collections
import hashlib
import json
import re
import sqlite3
import tarfile
import unicodedata
from pathlib import Path

from bs4 import BeautifulSoup


TOKEN = 0x4000
FIRST_PRERELEASE_CODE = 100_000_000
# Character decks and recurring themes from DM through VRAINS, plus DSOD.
ANIME_FIELDS = frozenset(int(code, 16) for code in """
    4 5 7 8 9 b f 13 16 2016 1017 2017 1c 1f 21 23 26 27 2b 31 32 33 34
    3b 3f 40 42 43 1045 1046 48 4a 4b 50 1050 1052 54 55 57 59 62 64 2066
    6d 70 76 7b 7e 7f 1083 1084 86 8f 1093 2093 4093 98 99 9a 9b 9f a0 a1
    10a2 20a2 a3 a4 a9 ad ae af ba bc bd c2 c3 c6 cc 10db dd de df e3 e5 e6
    e7 e8 e9 10ec 20ec f0 10f2 10f3 f5 f6 f7 10f8 20f8 fb fc ff 101 102
    103 10f 110 111 118 119 11a 122 1123 124 12b 135 136 13a 144 149 14a 14b
    1158 2158 4158 16e 175 176 1a5 1ae 1b4 1b8 1ba
    18 1a 1e 25 52 5c 63 6a 6b 85 8b 92 100 10e 125 12e 139 169 16a 186
    193 194 1b5 1c7 1d6 1d9 1de 104f 1185 2185 314c 514c 614c 914c
""".split())
OCG_THEMES = {
    'Ars Magna', 'Artmage', 'Azamina', 'Bystial', 'Clown Crew', 'Dogmatika', 'Elfnote', 'Fallen',
    'Fiendsmith', 'Kewl Tune', 'Light and Darkness', 'Mitsurugi', 'Power Patron', 'Raise Moon',
    'Shining Sarcophagus', 'Yummy',
}
EDITORIAL_CARDS = """
    A Wild Monster Appears!|Baby Dragon|Barrel Dragon|Blast Held by a Tribute|Blast Sphere|
    Castle of Dark Illusions|Celtic Guardian|Convulsion of Nature|Copycat|Cyber Jar|
    Dark Hole|Exchange|Exchange of the Spirit|Fiber Jar|Flame Swordsman|Flying Elephant|
    Gate Guardian|Gearfried the Iron Knight|Giant Soldier of Stone|Gilford the Lightning|
    Graceful Charity|Insect Queen|Jackpot 7|Jinzo|Judgment of the Pharaoh|Kuriboh|
    Last Turn|Linear Equation Cannon|Magic Cylinder|Magical Hats|Mammoth Graveyard|
    Mirror Force|Mokey Mokey|Monster Reborn|Morphing Jar|Mushroom Man #2|
    Mystical Elf|Mystical Refpanel|Panther Warrior|Perfectly Ultimate Great Moth|
    Pole Position|Pot of Greed|Pumpking the King of Ghosts|Question|Raigeki|
    Relinquished|Relay Soul|Self-Destruct Button|Shapesnatch|Simultaneous Equation Cannons|
    Sparks|Summoned Skull|Swords of Revealing Light|Swordsman of Landstar|The Humble Sentry|
    The Winged Dragon of Ra|Slifer the Sky Dragon|Obelisk the Tormentor|
    Thousand Dragon|Time Wizard|Transmission Gear|Unity|Victory Dragon|Yu-Jo Friendship|
    Hungry Burger|Time-Tearing Morganite
"""
EFFECT_SIGNALS = {
    'alternate-win-or-draw': r'\b(?:you|your opponent) win[s]? the (?:duel|match)\b|\bthis duel (?:ends|is declared) (?:in|as) a draw\b|这场决斗(?:的)?胜利|这场决斗成为平局',
    'extra-turn': r'\b(?:take|conduct|play) (?:an? |1 )?(?:extra|additional|another) turn\b|再进行(?:1|一)次自己的回合',
    'unusual-physical-rule': r'\brock.paper.scissors\b|\bshake hands\b|turn (?:both |each |your )?.{0,22}decks? upside down|猜拳|握手|卡组翻转',
}
DECK_SECTIONS = ('MainDeck', 'ExtraDeck', 'SideDeck')
OFFICIAL_DECK_SNAPSHOTS = (
    'konami-columbus-2026.html', 'konami-houston-2026.html', 'konami-remote-2025.html',
    'konami-vancouver-2025.html', 'konami-wcq-2025.html', 'konami-wcq-2026.html',
)
OCG_REPORTS = ('ocg-october-1.html', 'ocg-october-2-4.html')


def normalize(name):
    return ''.join(ch for ch in unicodedata.normalize('NFKC', name).casefold() if ch.isalnum())


def setcodes(value):
    return {(value >> offset) & 0xffff for offset in range(0, 64, 16)} - {0}


def artwork_index(cards):
    parents = {code: code for code in cards}

    def find(code):
        while parents[code] != code:
            parents[code] = parents[parents[code]]
            code = parents[code]
        return code

    for code, card in cards.items():
        alias = card['alias']
        if code != 5_405_695 and alias in cards and 0 < abs(code - alias) < 20:
            a, b = find(code), find(alias)
            parents[max(a, b)] = min(a, b)
    return {code: find(code) for code in cards}


def field_memberships(cards, artwork, strings):
    fields = {}
    for match in re.finditer(r'^!setname\s+0x([0-9a-f]+)\s+([^\t\r\n]+)', strings, re.M | re.I):
        fields[int(match[1], 16)] = match[2].strip()
    tags = {code: setcodes(card['setcode']) for code, card in cards.items()}
    for tag in set().union(*tags.values()):
        fields.setdefault(tag, f'0x{tag:04x}')
    family = collections.defaultdict(list)
    for field in fields:
        family[field & 0xfff].append(field)
    memberships = collections.defaultdict(set)
    members = {field: set() for field in fields}
    for code, card_tags in tags.items():
        representative = artwork[code]
        for tag in card_tags:
            for field in family[tag & 0xfff]:
                flags = field & 0xf000
                if tag & flags == flags:
                    memberships[representative].add(field)
                    members[field].add(representative)
    return fields, memberships, members


def json_read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def index_signals(cards, artwork, card_catalog, names):
    name_index = collections.defaultdict(set)
    by_code = {}
    archetypes = collections.defaultdict(set)
    for code, card in cards.items():
        entry = names.get(str(code), {})
        for name in (card['name'], entry.get('en_name'), entry.get('jp_name')):
            if name:
                name_index[normalize(name)].add(artwork[code])
    for card in card_catalog:
        code = int(card['id'])
        if code in artwork:
            representative = artwork[code]
        else:
            prints = {artwork[image['id']] for image in card.get('card_images', []) if image['id'] in artwork}
            if len(prints) != 1:
                continue
            representative, = prints
        for name in (card['name'], *(entry.get('beta_name') for entry in card.get('misc_info', []))):
            if name:
                name_index[normalize(name)].add(representative)
        if card.get('archetype'):
            archetypes[normalize(card['archetype'])].add(representative)
        by_code[representative] = card
    return name_index, by_code, archetypes


def historical_decks(archive):
    with tarfile.open(archive) as bundle:
        for member in bundle:
            if not (member.isfile() and re.search(r'/decks/deck_\d+\.json$', member.name)):
                continue
            deck = json.load(bundle.extractfile(member))
            if not deck.get('Placed') or not deck.get('Tournament'):
                continue
            # Only accept records with plausible constructed deck sizes and a recorded finish.
            sizes = [sum(int(card['Copies']) for card in deck[zone]) for zone in DECK_SECTIONS]
            if 40 <= sizes[0] <= 60 and max(sizes[1:]) <= 15:
                yield tuple([card['Name'] for card in deck[zone]] for zone in DECK_SECTIONS)


def official_decks(path):
    soup = BeautifulSoup(path.read_text(encoding='utf-8'), 'html.parser')
    post = soup.select_one('[itemprop="articleBody"]')
    if post is None:
        raise ValueError(f'Missing article in {path.name}')
    for br in post.find_all('br'):
        br.replace_with('\n')
    deck = None
    zone = 0
    for paragraph in post.find_all(['p', 'h3', 'h4', 'li']):
        for line in paragraph.get_text().splitlines():
            line = line.strip()
            if re.match(r'Main Deck\s*[:–-]\s*\d', line, re.I):
                if deck and len(deck[0]) >= 10:
                    yield deck
                deck = ([], [], [])
                zone = 0
            elif re.match(r'Extra Deck\b', line, re.I):
                zone = 1
            elif re.match(r'Side Deck\b', line, re.I):
                zone = 2
            elif deck and (entry := re.fullmatch(r'[1-3]\s*[x×]?\s+(.+)', line)):
                deck[zone].append(entry[1].strip())
    if deck and len(deck[0]) >= 10:
        yield deck


def competition_counts(sources, names, memberships):
    card_counts = collections.Counter()
    field_counts = collections.Counter()
    rejected_names = collections.Counter()
    decks_by_source = {}
    for label, decks in (
        ('historical', historical_decks(sources / 'ytd-archive.tar.gz')),
        *((Path(name).stem, official_decks(sources / name)) for name in OFFICIAL_DECK_SNAPSHOTS),
    ):
        count = 0
        for deck in decks:
            zones = []
            for zone in deck:
                matched = set()
                for name in zone:
                    choices = names.get(normalize(name), set())
                    if len(choices) == 1:
                        matched.update(choices)
                    else:
                        rejected_names[name] += 1
                zones.append(matched)
            if len(zones[0]) < 10:
                continue
            count += 1
            played = set().union(*zones)
            card_counts.update(played)
            # Distinct in-deck members, excluding side-only groupings.
            core_fields = {field for code in zones[0] | zones[1] for field in memberships[code]}
            occurrences = collections.Counter(field for code in played for field in memberships[code])
            field_counts.update(field for field, n in occurrences.items() if n >= 2 and field in core_fields)
        if not count:
            raise ValueError(f'No competitive decks matched for {label}')
        decks_by_source[label] = count
    return card_counts, field_counts, decks_by_source, rejected_names


def percentile(values, p):
    ordered = sorted(value for value in values if value)
    return ordered[int(len(ordered) * p)]


def popularity(index):
    counts = {code: (row.get('misc_info') or [{}])[0] for code, row in index.items()}
    lifetime = percentile((row.get('views', 0) for row in counts.values()), .90)
    weekly = percentile((row.get('viewsweek', 0) for row in counts.values()), .95)
    popular = {
        code for code, row in counts.items()
        if row.get('views', 0) >= lifetime
        or (row.get('viewsweek', 0) >= weekly and row.get('upvotes', 0) - row.get('downvotes', 0) >= 4)
    }
    return popular, counts, {'viewsP90': lifetime, 'viewsWeekP95': weekly}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cdb', type=Path, required=True)
    parser.add_argument('--strings', type=Path, required=True)
    parser.add_argument('--banlist', type=Path, required=True)
    parser.add_argument('--names', type=Path, required=True)
    parser.add_argument('--sources', type=Path, required=True)
    parser.add_argument('--audit', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    catalog = {}
    expansion_rows = {}
    for source in (args.cdb, *sorted((args.cdb.parent / 'expansions').glob('*.cdb'))):
        with sqlite3.connect(source.resolve().as_uri() + '?mode=ro', uri=True) as conn:
            conn.row_factory = sqlite3.Row
            rows = {row['id']: dict(row) for row in conn.execute(
                'SELECT d.id, d.alias, d.type, d.setcode, t.name, t.desc FROM datas d LEFT JOIN texts t USING(id)'
            )}
        if source != args.cdb:
            expansion_rows[source.name] = {'rows': len(rows), 'sha256': hashlib.sha256(source.read_bytes()).hexdigest()}
        catalog.update(rows)
    cards = {code: row for code, row in catalog.items()
             if 0 < code < FIRST_PRERELEASE_CODE and not row['type'] & TOKEN}
    artwork = artwork_index(cards)
    fields, membership, members = field_memberships(cards, artwork, args.strings.read_text(encoding='utf-8-sig'))
    card_data = json_read(args.sources / 'ygoprodeck-cards.json')['data']
    names, metadata, archetypes = index_signals(cards, artwork, card_data, json_read(args.names))
    tournament, field_tournament, deck_counts, unmatched = competition_counts(args.sources, names, membership)
    popular, view_counts, thresholds = popularity(metadata)
    staples = {artwork[row['id']] for row in json_read(args.sources / 'ygoprodeck-staples.json')['data']
               if row['id'] in artwork}
    banned = {artwork[code] for match in re.finditer(r'^(\d+)\s+[01]\b', args.banlist.read_text(encoding='utf-8-sig'), re.M)
              if (code := int(match[1])) in artwork}
    ocg_fields = collections.defaultdict(list)
    report_text = normalize(' '.join(
        BeautifulSoup((args.sources / report).read_text(encoding='utf-8'), 'html.parser').get_text(' ')
        for report in OCG_REPORTS
    ))
    for theme in sorted(OCG_THEMES):
        if normalize(theme) not in report_text:
            continue
        theme_codes = archetypes[normalize(theme)]
        for field in {tag for code in theme_codes for tag in membership[code]}:
            if len(theme_codes & members[field]) >= max(2, (len(theme_codes) + 1) // 2):
                ocg_fields[field].append(theme)
    editorial = {}
    editorial_unknown = []
    for name in (entry.strip() for entry in EDITORIAL_CARDS.split('|')):
        matches = names.get(normalize(name), set())
        if len(matches) == 1:
            editorial[next(iter(matches))] = name
        else:
            editorial_unknown.append(name)

    chosen_fields = {}
    field_audit = []
    for field, label in sorted(fields.items()):
        count = len(members[field])
        popular_count = len(members[field] & popular)
        reasons = []
        if field_tournament[field]:
            reasons.append('tournament-deck')
        if ocg_fields[field]:
            reasons.append('ocg-reported-theme')
        if field in ANIME_FIELDS:
            reasons.append('anime-character-theme')
        if popular_count >= max(2, (count + 4) // 5):
            reasons.append('popularity')
        if count and reasons:
            chosen_fields[field] = reasons
        field_audit.append({'field': f'0x{field:04x}', 'name': label, 'eligibleCards': count,
                            'decks': field_tournament[field], 'popularCards': popular_count,
                            'ocgThemes': ocg_fields[field], 'selectedBy': reasons if count else []})

    groups = collections.defaultdict(list)
    for code, representative in artwork.items():
        groups[representative].append(code)
    selected = []
    card_audit = []
    singles = collections.Counter()
    field_cards = 0
    for code, copies in sorted(groups.items()):
        matched_fields = sorted(set(chosen_fields) & membership[code])
        reasons = []
        if matched_fields:
            reasons.append('selected-field')
            field_cards += 1
        else:
            for signal, matched in (
                ('tournament-card', bool(tournament[code])), ('popular-card', code in popular),
                ('staple', code in staples), ('historical-ban-or-limit', code in banned),
                ('editorial-anime-or-effect', code in editorial),
            ):
                if matched:
                    reasons.append(signal)
            desc = (metadata.get(code, {}).get('desc', '') or '') + '\n' + (cards[code]['desc'] or '')
            for signal, pattern in EFFECT_SIGNALS.items():
                if re.search(pattern, desc, re.I):
                    reasons.append(signal)
            singles.update(reasons)
        if reasons:
            selected.append(code)
        card_audit.append({
            'code': code, 'name': cards[code]['name'], 'artworks': sorted(copies),
            'ruleAlias': cards[code]['alias'] if cards[code]['alias'] and
            artwork.get(cards[code]['alias']) != code else None,
            'matchedFields': [f'0x{field:04x}' for field in matched_fields],
            'tournamentDecks': tournament[code], 'views': view_counts.get(code, {}).get('views'),
            'viewsWeek': view_counts.get(code, {}).get('viewsweek'), 'selectedBy': reasons,
        })
    selected_codes = set(selected)
    for field, row in zip(sorted(fields), field_audit):
        row['includedCards'] = len(members[field] & selected_codes)
        if field in chosen_fields:
            assert members[field] <= selected_codes
    assert all(artwork[code] == code for code in selected)

    args.audit.mkdir(parents=True, exist_ok=True)
    (args.audit / 'fields.json').write_text(json.dumps(field_audit, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    with (args.audit / 'cards.jsonl').open('w', encoding='utf-8') as file:
        for card in card_audit:
            file.write(json.dumps(card, ensure_ascii=False) + '\n')
    with (args.out).open('w', encoding='utf-8', newline='\n') as file:
        file.write('// Generated by scripts/generate-guess-default-pool.py. Exact codes sorted by ID.\n')
        file.write('export const DEFAULT_GUESS_POOL_CODES: readonly number[] = [\n')
        for offset in range(0, len(selected), 10):
            file.write('  ' + ', '.join(map(str, selected[offset:offset + 10])) + ',\n')
        file.write('];\n')
    summary = {
        'mainCdbSha256': hashlib.sha256(args.cdb.read_bytes()).hexdigest(),
        'expansionSources': expansion_rows,
        'catalogRows': len(catalog), 'eligibleExactCodes': len(cards), 'eligibleArtworkGroups': len(groups),
        'excludedPrereleaseRows': sum(code >= FIRST_PRERELEASE_CODE for code in catalog),
        'excludedTokenRows': sum(bool(row['type'] & TOKEN) for row in catalog.values()),
        'fieldsReviewed': len(fields), 'fieldsSelected': len(chosen_fields),
        'seriesCards': field_cards, 'individualCards': len(selected) - field_cards, 'totalCards': len(selected),
        'individualSignals': singles, 'competitiveDecksBySource': deck_counts, 'popularity': thresholds,
        'sourceSha256': {name: hashlib.sha256((args.sources / name).read_bytes()).hexdigest() for name in (
            'ytd-archive.tar.gz', 'ygoprodeck-cards.json', 'ygoprodeck-staples.json',
            *OFFICIAL_DECK_SNAPSHOTS, *OCG_REPORTS,
        )},
        'unmatchedDeckNames': unmatched.most_common(25), 'unmatchedEditorialNames': editorial_unknown,
    }
    (args.audit / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == '__main__':
    main()
