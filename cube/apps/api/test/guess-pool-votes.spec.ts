import type { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { GuessCardPage, GuessPoolCardVotes, GuessPoolProposalPage, GuessPoolProposals, GuessPoolSummary } from '@ygocube/shared';
import fs from 'node:fs';
import { AuthGuard } from '../src/auth/auth.guard';
import { CardsService, TYPE_TOKEN } from '../src/cards/cards.service';
import { config } from '../src/config';
import { closeDb, getDb } from '../src/db';
import { GuessController } from '../src/guess/guess.controller';
import { GuessPoolsService } from '../src/guess/guess-pools.service';
import { GuessPoolVotesService } from '../src/guess/guess-pool-votes.service';
import { GuessService } from '../src/guess/guess.service';
import { normalizeVoterIp, voterIp } from '../src/guess/voter-ip';
import { useTestDb } from './helpers';

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], value = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && ch === ',') { row.push(value); value = ''; }
    else if (!quoted && ch === '\r' && text[i + 1] === '\n') {
      row.push(value); rows.push(row); row = []; value = ''; i++;
    } else value += ch;
  }
  return rows;
}

describe('Guess pool votes and CSV HTTP', () => {
  let app: INestApplication;
  let base: string;
  let namesFile: string;
  let pools: GuessPoolsService;
  const originalNames = config.server.cardNamesJson;
  const token = 'pool-vote-test-admin';
  const members = [10000, 10001, 10002, 10003, 10004];
  const art = 10020, variant = 10021, rule = 10055, generated = 10008;
  let index = 0;

  beforeAll(async () => {
    useTestDb();
    namesFile = `${config.server.dbPath}.names.json`;
    fs.writeFileSync(namesFile, JSON.stringify([
      { id: members[0], sc_name: '简中"名称,甲', nwbbs_n: '论坛译名甲', jp_name: '日本語甲', en_name: 'English Alpha' },
      { id: art, sc_name: '原版简中', nwbbs_n: '原版论坛', jp_name: '原版日本語', en_name: 'Original Artwork' },
    ]));
    config.server.cardNamesJson = namesFile;
    config.admin.superToken = token;
    const cards = new CardsService();
    cards.poolCodes();
    const db = getDb();
    db.prepare('UPDATE cards SET alias = ? WHERE code = ?').run(art, variant);
    db.prepare('UPDATE cards SET alias = ? WHERE code = ?').run(art, rule);
    db.prepare('UPDATE cards SET type = ? WHERE code = ?').run(TYPE_TOKEN | 1, generated);
    db.prepare('UPDATE cards SET desc = ?, type = ?, atk = -1, def = 0, race = 8192, attribute = 16, setcodes_json = ?, setnames_json = ? WHERE code = ?')
      .run('文本,"引号"\n第二行', 0x21, '[258]', '["字段甲"]', members[0]);
    db.prepare('UPDATE cards SET type = ?, level = 3, link_markers = 67, atk = 2300, def = 0 WHERE code = ?').run(0x4000021, members[1]);
    db.prepare('UPDATE cards SET type = ?, level = 4 WHERE code = ?').run(0x800021, members[2]);
    db.prepare('UPDATE cards SET type = ?, lscale = 1, rscale = 8 WHERE code = ?').run(0x1000021, members[3]);
    db.prepare('UPDATE cards SET type = ?, desc = ? WHERE code = ?').run(0x10002, '=HYPERLINK("bad")', members[4]);
    const module = await Test.createTestingModule({
      controllers: [GuessController],
      providers: [GuessService, GuessPoolsService, GuessPoolVotesService, { provide: CardsService, useValue: cards },
        { provide: APP_GUARD, useClass: AuthGuard }],
    }).compile();
    app = module.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/games/guess`;
    pools = app.get(GuessPoolsService);
  });

  afterAll(async () => {
    if (app) await app.close();
    closeDb();
    for (const suffix of ['', '-wal', '-shm', '.pre-auth-migration.bak', '.names.json']) fs.rmSync(config.server.dbPath + suffix, { force: true });
    config.server.cardNamesJson = originalNames;
  });

  async function request<T = { code: string }>(path: string, ip = '192.0.2.1', body?: unknown) {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Real-IP': ip }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as T };
  }
  const create = (codes = members) => pools.create({ name: `Vote fixture ${++index}`, codes }).poolId;
  const like = (id: number, code: number, ip = '192.0.2.1', vote: string | null = 'like') =>
    request<GuessPoolCardVotes>(`/pools/${id}/cards/${code}/vote`, ip, { vote });
  const propose = (id: number, code: number, ip = '192.0.2.1') => request<GuessPoolProposals>(`/pools/${id}/proposals`, ip, { code });
  const proposeMany = (id: number, codes: number[], ip = '192.0.2.1') => request<GuessPoolProposals>(`/pools/${id}/proposals`, ip, { codes });

  it('counts one current choice per IP, card and pool and permits idempotent repeats and switching', async () => {
    const id = create();
    expect((await like(id, members[0])).body).toEqual({ likes: 1, dislikes: 0, mine: 'like' });
    expect((await like(id, members[0])).body).toEqual({ likes: 1, dislikes: 0, mine: 'like' });
    expect((await like(id, members[0], '192.0.2.1', 'dislike')).body).toEqual({ likes: 0, dislikes: 1, mine: 'dislike' });
    expect((await like(id, members[0])).body).toEqual({ likes: 1, dislikes: 0, mine: 'like' });
    expect((await like(id, members[0], '192.0.2.2', 'dislike')).body).toEqual({ likes: 1, dislikes: 1, mine: 'dislike' });
    expect((await like(id, members[1])).status).toBe(200);
    expect((await like(create(), members[0])).status).toBe(200);
    const page = (await request<GuessCardPage>(`/pools/${id}/cards`, '192.0.2.3')).body;
    expect(page.cards.find(({ code }) => code === members[0])?.votes).toEqual({ likes: 1, dislikes: 1, mine: null });
    const ownPage = (await request<GuessCardPage>(`/pools/${id}/cards`)).body;
    expect(ownPage.cards.find(({ code }) => code === members[0])?.votes?.mine).toBe('like');
  });

  it('counts mapped IPv4 spellings as one voter under concurrent opposite submissions', async () => {
    const id = create();
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => like(id, members[0], i % 2 ? '::ffff:c000:201' : '192.0.2.1', i % 2 ? 'like' : 'dislike')));
    expect(results.every(({ status }) => status === 200)).toBe(true);
    expect(getDb().prepare('SELECT COUNT(*) FROM guess_pool_card_votes WHERE pool_id = ?').pluck().get(id)).toBe(1);
    const page = (await request<GuessCardPage>(`/pools/${id}/cards`)).body;
    const votes = page.cards.find(({ code }) => code === members[0])!.votes!;
    expect(votes.likes + votes.dislikes).toBe(1);
  });

  it('freely cancels and reselects without changing another IP vote or renewing the daily proposal quota', async () => {
    const id = create();
    await propose(id, 10009);
    await like(id, members[0]);
    await like(id, members[0], '192.0.2.2');
    expect((await like(id, members[0], '192.0.2.1', 'dislike')).body).toEqual({ likes: 1, dislikes: 1, mine: 'dislike' });
    for (let i = 0; i < 2; i++) {
      expect((await like(id, members[0], '192.0.2.1', null)).body).toEqual({ likes: 1, dislikes: 0, mine: null });
    }
    expect((await like(id, members[0])).body).toEqual({ likes: 2, dislikes: 0, mine: 'like' });
    expect((await request<GuessPoolProposals>(`/pools/${id}/proposals`)).body.remainingVotes).toBe(9);
    expect((await propose(id, 10010)).body.remainingVotes).toBe(8);
  });

  it('keeps other voters intact while concurrent updates and cancellations race', async () => {
    const id = create();
    await like(id, members[0], '192.0.2.2');
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      like(id, members[0], '192.0.2.1', [null, 'like', 'dislike'][i % 3])));
    expect(results.every(({ status }) => status === 200)).toBe(true);
    const count = getDb().prepare('SELECT COUNT(*) FROM guess_pool_card_votes WHERE pool_id = ?').pluck().get(id) as number;
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(2);
    const page = (await request<GuessCardPage>(`/pools/${id}/cards`, '192.0.2.2')).body;
    const votes = page.cards.find(({ code }) => code === members[0])!.votes!;
    expect(votes.mine).toBe('like');
    expect(votes.likes + votes.dislikes).toBe(count);
  });

  it('enforces each pool daily proposal quota independently of card ratings and other IPs', async () => {
    const id = create(), other = create();
    expect((await like(id, members[0])).status).toBe(200);
    const first = await propose(id, 10009);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ votedCode: 10009, votedCodes: [10009], dailyLimit: 10, remainingVotes: 9,
      canVote: true, top: [{ card: { code: 10009 }, votes: 1 }] });
    for (let code = 10010; code <= 10018; code++) expect((await propose(id, code)).status).toBe(200);
    expect((await propose(id, 10019)).body).toMatchObject({ code: 'GUESS_PROPOSAL_DAILY_LIMIT' });
    expect((await propose(id, 10009)).body).toMatchObject({ code: 'GUESS_PROPOSAL_ALREADY_VOTED' });
    expect((await propose(other, 10009)).status).toBe(200);
    expect((await propose(id, 10009, '192.0.2.2')).body.top[0].votes).toBe(2);
    expect((await like(id, members[1])).status).toBe(200);
    expect(pools.get(id).codes).toEqual(members);
  });

  it('resets the ten-card quota at Beijing midnight without resetting votes for individual cards', async () => {
    const id = create();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-17T15:59:59.999Z'));
    try {
      const first = (await propose(id, 10009)).body;
      expect(first.voteDate).toBe('2026-11-17');
      expect(first.nextVoteAt).toBe('2026-11-17T16:00:00.000Z');
      clock.mockReturnValue(Date.parse('2026-11-17T16:00:00.000Z'));
      const next = (await request<GuessPoolProposals>(`/pools/${id}/proposals`)).body;
      expect(next).toMatchObject({ voteDate: '2026-11-18', votedCode: null, canVote: true });
      expect(next.remainingVotes).toBe(10);
      expect((await propose(id, 10009)).body).toMatchObject({ code: 'GUESS_PROPOSAL_ALREADY_VOTED' });
      expect((await propose(id, 10010)).body.remainingVotes).toBe(9);
      expect((await like(id, members[0])).status).toBe(200);
      clock.mockReturnValue(Date.parse('2026-11-18T16:00:00.000Z'));
      expect((await like(id, members[0])).body.mine).toBe('like');
      expect((await propose(id, 10009)).body).toMatchObject({ code: 'GUESS_PROPOSAL_ALREADY_VOTED' });
    } finally { clock.mockRestore(); }
  });

  it('limits simultaneous proposal requests to ten different cards and rejects duplicate cards', async () => {
    const id = create();
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => propose(id, 10009 + i)));
    expect(results.filter(({ status }) => status === 200)).toHaveLength(10);
    expect(results.filter(({ status }) => status === 409)).toHaveLength(2);
    const duplicates = await Promise.all(Array.from({ length: 8 }, () => propose(id, 10009, '192.0.2.2')));
    expect(duplicates.filter(({ status }) => status === 200)).toHaveLength(1);
    expect(duplicates.filter(({ status }) => status === 409)).toHaveLength(7);
  });

  it('casts a batch once, canonicalizes artworks and exposes lifetime vote flags in the Top 5', async () => {
    const id = create();
    const result = await proposeMany(id, [10009, variant, rule]);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ remainingVotes: 7, votedCodes: [10009, art, rule] });
    expect(result.body.top.map(({ card, votes, voted }) => [card.code, votes, voted]))
      .toEqual([[10009, 1, true], [art, 1, true], [rule, 1, true]]);
    const other = (await request<GuessPoolProposals>(`/pools/${id}/proposals`, '192.0.2.2')).body;
    expect(other.remainingVotes).toBe(10);
    expect(other.top.every(({ voted }) => !voted)).toBe(true);
    getDb().prepare('UPDATE guess_pool_proposal_ballots SET vote_date=? WHERE pool_id=?').run('2026-01-01', id);
    const nextDay = (await request<GuessPoolProposals>(`/pools/${id}/proposals`)).body;
    expect(nextDay.remainingVotes).toBe(10);
    expect(nextDay.top.every(({ voted }) => voted)).toBe(true);
    expect((await propose(id, art)).body).toMatchObject({ code: 'GUESS_PROPOSAL_ALREADY_VOTED' });
  });

  it('rejects an invalid or newly promoted card without casting any of the batch', async () => {
    const id = create();
    for (const [bad, status, code] of [[generated, 400, 'GUESS_INVALID_PROPOSAL'],
      [999999999, 400, 'GUESS_INVALID_PROPOSAL'], [members[0], 409, 'GUESS_CARD_ALREADY_IN_POOL']] as const) {
      const result = await proposeMany(id, [10009, bad]);
      expect(result.status).toBe(status);
      expect(result.body).toMatchObject({ code });
      expect(getDb().prepare('SELECT COUNT(*) FROM guess_pool_proposal_ballots WHERE pool_id=?').pluck().get(id)).toBe(0);
      expect((await request<GuessPoolProposals>(`/pools/${id}/proposals`)).body.remainingVotes).toBe(10);
    }
  });

  it('rejects malformed, oversized and repeated-artwork batches without consuming quota', async () => {
    const id = create();
    for (const body of [{}, { codes: [] }, { codes: [10009, 10009] }, { codes: [art, variant] },
      { codes: '10009' }, { codes: [10009, '10010'] }, { codes: [10009, 1.5] }, { codes: [null] },
      { codes: [0] }, { codes: [Number.MAX_SAFE_INTEGER + 1] },
      { codes: Array.from({ length: 11 }, (_, i) => 10009 + i) }, { code: 10009, codes: [10010] }, { codes: [10009], ip: 'fake' }]) {
      const result = await request(`/pools/${id}/proposals`, '192.0.2.1', body);
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ code: 'BAD_PAYLOAD' });
    }
    expect((await request<GuessPoolProposals>(`/pools/${id}/proposals`)).body).toMatchObject({ remainingVotes: 10, top: [] });
  });

  it('shares quota with single votes and rolls back a batch containing a previously supported card', async () => {
    const id = create();
    await propose(id, 10009);
    expect((await proposeMany(id, [10010, 10009])).body).toMatchObject({ code: 'GUESS_PROPOSAL_ALREADY_VOTED' });
    expect((await request<GuessPoolProposals>(`/pools/${id}/proposals`)).body).toMatchObject({ votedCodes: [10009], remainingVotes: 9 });
    const accepted = await proposeMany(id, Array.from({ length: 8 }, (_, i) => 10010 + i));
    expect(accepted.status).toBe(200);
    expect(accepted.body.remainingVotes).toBe(1);
    expect((await proposeMany(id, [10018, 10019])).body).toMatchObject({ code: 'GUESS_PROPOSAL_DAILY_LIMIT' });
    expect(getDb().prepare('SELECT COUNT(*) FROM guess_pool_proposal_ballots WHERE pool_id=?').pluck().get(id)).toBe(9);
    expect((await propose(id, 10019)).body.remainingVotes).toBe(0);
    expect((await proposeMany(create(), [10009, 10010])).body.remainingVotes).toBe(8);
  });

  it('prevents overlapping concurrent batches from partially casting or exceeding ten cards', async () => {
    const id = create();
    const groups = [[10009, 10010, 10011, 10012], [10012, 10013, 10014, 10015], [10016, 10017, 10018, 10019],
      [art, 10022, 10023, 10024]];
    const results = await Promise.all(groups.map((codes) => proposeMany(id, codes)));
    expect(results.filter(({ status }) => status === 200)).toHaveLength(2);
    expect(results.filter(({ status }) => status === 409)).toHaveLength(2);
    const voted = getDb().prepare('SELECT code FROM guess_pool_proposal_ballots WHERE pool_id=? ORDER BY code').pluck().all(id);
    expect(voted).toEqual(groups.filter((_, i) => results[i].status === 200).flat().sort((a, b) => a - b));
    expect(voted).toHaveLength(8);
    expect((await request<GuessPoolProposals>(`/pools/${id}/proposals`)).body.remainingVotes).toBe(2);
  });

  it('excludes members and their artworks, canonicalizes proposed artworks, and keeps rules-name cards independent', async () => {
    const id = create([variant, members[0]]);
    for (const code of [variant, art, members[0]]) expect((await propose(id, code)).status).toBe(409);
    const results = (await request<GuessCardPage>(`/pools/${id}/proposals/cards`)).body.cards.map(({ code }) => code);
    expect(results).not.toContain(art);
    expect(results).not.toContain(variant);
    expect(results).not.toContain(generated);
    expect((await propose(id, rule)).status).toBe(200);
    const second = create();
    expect((await propose(second, variant)).body).toMatchObject({ votedCode: art, top: [{ card: { code: art }, votes: 1 }] });
    expect((await request(`/pools/${second}/proposals/cards?atkMin=10`)).status).toBe(400);
    expect((await request<GuessCardPage>(`/pools/${second}/proposals/cards?q=测试用效果文本`)).body.totalCount).toBe(0);
  });

  it('ranks five proposals by votes then code, hiding promoted cards while preserving their votes', async () => {
    const id = create();
    for (let i = 0; i < 7; i++) expect((await propose(id, 10010 + i, `192.0.2.${i + 10}`)).status).toBe(200);
    const ranked = (await propose(id, 10016, '192.0.2.30')).body.top;
    expect(ranked.map(({ card }) => card.code)).toEqual([10016, 10010, 10011, 10012, 10013]);
    getDb().prepare('UPDATE guess_pools SET codes_json = ? WHERE id = ?').run(JSON.stringify([...members, 10016]), id);
    expect((await request<GuessPoolProposals>(`/pools/${id}/proposals`)).body.top.map(({ card }) => card.code)).toEqual([10010, 10011, 10012, 10013, 10014]);
    expect(getDb().prepare('SELECT COUNT(*) FROM guess_pool_proposal_ballots WHERE pool_id = ? AND code = 10016').pluck().get(id)).toBe(2);
  });

  it('rejects invalid payloads, nonmembers, tokens and missing pools without consuming quotas', async () => {
    const id = create();
    for (const body of [{ vote: 'other' }, { vote: 'like', ip: 'fake' }, { vote: ['like'] }]) {
      expect((await request(`/pools/${id}/cards/${members[0]}/vote`, '192.0.2.1', body)).status).toBe(400);
    }
    expect((await like(id, 10009)).status).toBe(400);
    for (const code of [generated, 999999999]) expect((await propose(id, code)).status).toBe(400);
    expect((await request(`/pools/${id}/proposals`, '192.0.2.1', { code: '10009' })).status).toBe(400);
    expect((await request('/pools/999999/proposals')).status).toBe(404);
    expect((await request<GuessPoolProposals>(`/pools/${id}/proposals`)).body.canVote).toBe(true);
    expect((await request<GuessPoolProposals>('/pools/0/proposals')).body).toMatchObject({ top: [], hasCandidates: false, canVote: false });
    expect((await like(0, members[0])).status).toBe(200);
  });

  it('paginates the complete proposal ranking before rendering and shares the daily vote quota', async () => {
    const id = create();
    const proposed = app.get(CardsService).poolCodes().slice(200, 231);
    for (let i = 0; i < proposed.length; i++) await propose(id, proposed[i], `192.0.2.${80 + i}`);
    await propose(id, proposed[30], '192.0.2.120');
    const expected = [proposed[30], ...proposed.slice(0, 30)];
    const first = (await request<GuessPoolProposalPage>(`/pools/${id}/proposals/ranking`)).body;
    const second = (await request<GuessPoolProposalPage>(`/pools/${id}/proposals/ranking?page=1`)).body;
    expect(first).toMatchObject({ totalCount: 31, totalPages: 2, hasMore: true, canVote: true });
    expect([...first.proposals, ...second.proposals].map(({ card }) => card.code)).toEqual(expected);
    expect(second.proposals.map(({ rank }) => rank)).toEqual([25, 26, 27, 28, 29, 30, 31]);
    expect((await request<GuessPoolProposalPage>(`/pools/${id}/proposals/ranking?page=99`)).body)
      .toMatchObject({ proposals: [], totalCount: 31, totalPages: 2, hasMore: false });
    const supported = second.proposals[0].card.code;
    await propose(id, supported);
    const refreshed = (await request<GuessPoolProposalPage>(`/pools/${id}/proposals/ranking`)).body;
    expect(refreshed).toMatchObject({ canVote: true, votedCode: supported, remainingVotes: 9 });
    expect(refreshed.proposals.find(({ card }) => card.code === supported)?.votes).toBe(2);
    expect(refreshed.proposals.find(({ card }) => card.code === supported)?.voted).toBe(true);
    expect((await propose(id, supported)).status).toBe(409);
    const top = (await request<GuessPoolProposals>(`/pools/${id}/proposals`)).body.top;
    expect(top).toEqual(refreshed.proposals.slice(0, 5).map(({ rank: _rank, ...row }) => row));
  });

  it('searches only ranked proposals by multilingual names and keeps their absolute rank', async () => {
    const id = create([members[1], members[2]]);
    await propose(id, members[0]);
    await propose(id, variant, '192.0.2.2');
    for (const q of ['名称,甲', '论坛译名甲', '日本語甲', '"English Alpha"']) {
      const page = (await request<GuessPoolProposalPage>(`/pools/${id}/proposals/ranking?q=${encodeURIComponent(q)}`)).body;
      expect(page).toMatchObject({ totalCount: 1, proposals: [{ card: { code: members[0] }, rank: 1, votes: 1 }] });
    }
    const translated = (await request<GuessPoolProposalPage>(`/pools/${id}/proposals/ranking?q=original`)).body;
    expect(translated).toMatchObject({ totalCount: 1, proposals: [{ card: { code: art }, rank: 2 }] });
    expect((await request<GuessPoolProposalPage>(`/pools/${id}/proposals/ranking?q=测试用效果文本`)).body.totalCount).toBe(0);
    for (const query of ['atkMin=0', 'sort=name', 'page=-1', 'q=a&q=b']) expect((await request(`/pools/${id}/proposals/ranking?${query}`)).status).toBe(400);
    getDb().prepare('UPDATE guess_pools SET codes_json=? WHERE id=?').run(JSON.stringify([members[0], members[1], variant]), id);
    expect((await request<GuessPoolProposalPage>(`/pools/${id}/proposals/ranking`)).body).toMatchObject({ proposals: [], totalCount: 0 });
    expect((await request<GuessPoolProposalPage>('/pools/0/proposals/ranking')).body).toMatchObject({ proposals: [], canVote: false });
  });

  it('sorts by net opposition by default and supports other orders before pagination', async () => {
    const codes = app.get(CardsService).poolCodes().slice(100, 132);
    const id = create(codes);
    for (let i = 0; i < 3; i++) await like(id, codes[31], `192.0.2.${150 + i}`);
    await like(id, codes[30]);
    for (let i = 0; i < 2; i++) await like(id, codes[29], `192.0.2.${160 + i}`, 'dislike');
    await like(id, codes[30], '192.0.2.160', 'dislike');
    await like(id, codes[31], '192.0.2.160', 'dislike');
    const other = create(codes);
    await like(other, codes[0], '192.0.2.160', 'dislike');
    const netFirst = (await request<GuessCardPage>(`/pools/${id}/cards`)).body;
    const netSecond = (await request<GuessCardPage>(`/pools/${id}/cards?page=1`)).body;
    expect([...netFirst.cards, ...netSecond.cards].map(({ code }) => code))
      .toEqual([codes[29], ...codes.slice(0, 29), codes[30], codes[31]]);
    expect((await request<GuessCardPage>(`/pools/${id}/cards?voteSort=net-dislikes-desc`)).body).toEqual(netFirst);
    expect((await request<GuessCardPage>(`/pools/${id}/cards?voteSort=relevance`)).body.cards.map(({ code }) => code))
      .toEqual(codes.slice(0, 24));
    const expected = [codes[31], codes[30], ...codes.slice(0, 30)];
    const first = (await request<GuessCardPage>(`/pools/${id}/cards?voteSort=likes-desc`)).body;
    const second = (await request<GuessCardPage>(`/pools/${id}/cards?voteSort=likes-desc&page=1`)).body;
    expect(first.totalCount).toBe(32);
    expect([...first.cards, ...second.cards].map(({ code }) => code)).toEqual(expected);
    expect(first.cards[0].votes).toMatchObject({ likes: 3, dislikes: 1 });
    expect((await request<GuessCardPage>(`/pools/${id}/cards?voteSort=likes-asc`)).body.cards[0].code).toBe(codes[0]);
    expect((await request<GuessCardPage>(`/pools/${id}/cards?voteSort=dislikes-desc`)).body.cards[0].code).toBe(codes[29]);
    expect((await request<GuessCardPage>(`/pools/${id}/cards?voteSort=dislikes-asc`)).body.cards[0].code).toBe(codes[0]);
    expect((await request<GuessCardPage>(`/pools/${id}/cards?voteSort=likes-desc&q=${codes[0]}`)).body.cards.map(({ code }) => code)).toEqual([codes[0]]);
    const type = getDb().prepare('SELECT type FROM cards WHERE code=?').pluck().get(codes[0]);
    getDb().prepare('UPDATE cards SET type=2 WHERE code=?').run(codes[0]);
    expect((await request<GuessCardPage>(`/pools/${id}/cards?voteSort=likes-desc&category=2`)).body)
      .toMatchObject({ totalCount: 1, cards: [{ code: codes[0] }] });
    getDb().prepare('UPDATE cards SET type=? WHERE code=?').run(type, codes[0]);
    await like(id, codes[31], '192.0.2.150', null);
    expect((await request<GuessCardPage>(`/pools/${id}/cards?voteSort=likes-desc`)).body.cards[0].votes?.likes).toBe(2);
    for (const query of ['voteSort=bad', 'voteSort=likes-desc&sort=name', 'voteSort=likes-desc&voteSort=likes-asc']) {
      expect((await request(`/pools/${id}/cards?${query}`)).status).toBe(400);
    }
    getDb().prepare('UPDATE guess_pools SET name_key=? WHERE id=?').run('builtin:test-browse', id);
    try {
      expect((await request<GuessCardPage>(`/pools/${id}/cards?q=测试卡牌`)).body.cards[0].code).toBe(codes[29]);
      expect((await request<GuessCardPage>(`/pools/${id}/cards?voteSort=likes-desc&q=测试卡牌`)).body.cards[0].code).toBe(codes[31]);
      expect((await request(`/pools/${id}/cards?voteSort=likes-desc&category=1`)).status).toBe(400);
    } finally { getDb().prepare('UPDATE guess_pools SET name_key=? WHERE id=?').run(`name:vote-sorted-${id}`, id); }
  });

  it('exports the full pool with four source languages, escaped multiline text and all filtering data', async () => {
    const id = create();
    const response = await fetch(`${base}/pools/${id}/export.csv?q=no-match&page=999`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/csv; charset=utf-8/i);
    expect(response.headers.get('content-disposition')).toContain(`guess-pool-${id}.csv`);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const [header, ...rows] = parseCsv(bytes.subarray(3).toString('utf8'));
    expect(rows).toHaveLength(members.length);
    expect(rows.every((row) => row.length === header.length)).toBe(true);
    const mapped = rows.map((row) => Object.fromEntries(header.map((name, index) => [name, row[index]])));
    expect(mapped[0]).toMatchObject({ '卡片编号': '00010000', '卡名（SC）': '简中"名称,甲', '卡名（NWBBS）': '论坛译名甲',
      '卡名（日文）': '日本語甲', '卡名（英文）': 'English Alpha', '效果文本': '文本,"引号"\n第二行',
      '字段': '字段甲', '字段编号': '0x102', '种族': '龙族', '属性': '光', '攻击力': '?', '攻击力筛选值': '0' });
    expect(mapped[1]).toMatchObject({ '连接值': '3', '等级': '', '阶级': '', '守备力': '', '守备力筛选值': '', '连接标记数': '3', '连接标记位值': '67' });
    expect(mapped[2]).toMatchObject({ '阶级': '4', '等级': '', '连接值': '' });
    expect(mapped[3]).toMatchObject({ '灵摆左刻度': '1', '灵摆右刻度': '8' });
    expect(mapped[4]['效果文本']).toBe('\'=HYPERLINK("bad")');
    expect(mapped[4]['子类型']).toContain('速攻魔法');
    const names = app.get(CardsService);
    expect(names.localizedNames(variant).sc).toBe('原版简中');
    expect(names.localizedNames(rule).sc).toBe('');
    expect((await fetch(`${base}/pools/999999/export.csv`)).status).toBe(404);
  });

  it('imports legacy repeated daily votes as one lifetime ballot without deleting legacy history', async () => {
    const id = create();
    await like(id, members[0]);
    const hash = getDb().prepare('SELECT voter_hash FROM guess_pool_card_votes WHERE pool_id=?').pluck().get(id);
    const insert = getDb().prepare('INSERT INTO guess_pool_proposal_votes(pool_id,code,voter_hash,vote_date,created_at) VALUES (?,?,?,?,?)');
    insert.run(id, 10009, hash, '2026-11-01', '2026-11-01T00:00:00Z');
    insert.run(id, 10009, hash, '2026-11-02', '2026-11-02T00:00:00Z');
    insert.run(id, 10010, hash, '2026-11-03', '2026-11-03T00:00:00Z');
    const legacy = getDb().prepare('SELECT * FROM guess_pool_proposal_votes WHERE pool_id=? ORDER BY vote_date').all(id);
    for (let i = 0; i < 2; i++) {
      closeDb();
      expect(getDb().prepare('SELECT * FROM guess_pool_proposal_votes WHERE pool_id=? ORDER BY vote_date').all(id)).toEqual(legacy);
      expect(getDb().prepare('SELECT COUNT(*) FROM guess_pool_proposal_ballots WHERE pool_id=?').pluck().get(id)).toBe(2);
    }
    const ranked = (await request<GuessPoolProposalPage>(`/pools/${id}/proposals/ranking`)).body;
    expect(ranked.proposals.map(({ votes, voted }) => [votes, voted])).toEqual([[1, true], [1, true]]);
    expect((await propose(id, 10009)).body).toMatchObject({ code: 'GUESS_PROPOSAL_ALREADY_VOTED' });
    expect((await request<GuessCardPage>(`/pools/${id}/proposals/cards`)).body.cards.find(({ code }) => code === 10009)?.proposedByViewer).toBe(true);
  });

  it('preserves persisted votes, room data and statistics across database reopen and stores no literal IP', async () => {
    const id = create();
    await like(id, members[0], '198.51.100.61');
    await propose(id, 10009, '198.51.100.61');
    const session = app.get(GuessService).create({ name: 'Preserved room', playerId: 'host', poolId: id });
    getDb().prepare('INSERT INTO guess_round_cards(room_id, round_number, pool_id, code, guess_turns) VALUES (?, 1, ?, ?, 2)')
      .run(session.room.roomId, id, members[0]);
    const rooms = getDb().prepare('SELECT * FROM guess_rooms').all();
    const stats = getDb().prepare('SELECT * FROM guess_round_cards').all();
    const votes = getDb().prepare('SELECT * FROM guess_pool_card_votes WHERE pool_id = ?').all(id);
    expect(JSON.stringify(votes)).not.toContain('198.51.100.61');
    closeDb();
    expect(getDb().prepare('SELECT * FROM guess_pool_card_votes WHERE pool_id = ?').all(id)).toEqual(votes);
    expect(getDb().prepare('SELECT * FROM guess_rooms').all()).toEqual(rooms);
    expect(getDb().prepare('SELECT * FROM guess_round_cards').all()).toEqual(stats);
    expect((await like(id, members[0], '198.51.100.61', 'dislike')).body).toEqual({ likes: 0, dislikes: 1, mine: 'dislike' });
    expect((await like(id, members[0], '198.51.100.61', null)).body).toEqual({ likes: 0, dislikes: 0, mine: null });
    closeDb();
    expect(getDb().prepare('SELECT COUNT(*) FROM guess_pool_card_votes WHERE pool_id = ?').pluck().get(id)).toBe(0);
    expect((await propose(id, 10009, '198.51.100.61')).status).toBe(409);
    expect((await propose(id, 10010, '198.51.100.61')).status).toBe(200);
    expect(getDb().pragma('foreign_key_check')).toEqual([]);
    // An old database without vote tables acquires them without rewriting rooms.
    getDb().exec('DROP TABLE guess_pool_card_votes; DROP TABLE guess_pool_proposal_votes; DROP TABLE guess_pool_proposal_ballots');
    closeDb();
    expect(getDb().prepare('SELECT * FROM guess_rooms').all()).toEqual(rooms);
    expect(getDb().prepare('SELECT * FROM guess_round_cards').all()).toEqual(stats);
    expect(getDb().prepare('SELECT COUNT(*) FROM guess_pool_card_votes').pluck().get()).toBe(0);
  });
});

describe('Guess voter IP normalization and trusted proxy boundary', () => {
  it('normalizes equivalent IPv4 and IPv6 forms and rejects malformed input', () => {
    for (const ip of ['192.0.2.1', '::ffff:192.0.2.1', '::FFFF:c000:201']) expect(normalizeVoterIp(ip)).toBe('192.0.2.1');
    expect(normalizeVoterIp('2001:0DB8:0000::0001')).toBe('2001:db8::1');
    for (const ip of ['', 'not-an-ip', '192.0.2.1, 192.0.2.2', 'fe80::1%eth0', undefined]) expect(normalizeVoterIp(ip)).toBeNull();
  });
  it('uses a direct peer instead of untrusted forwarded headers', () => {
    const req = (remoteAddress: string, headers: Record<string, string | string[]>) => ({ socket: { remoteAddress }, headers }) as Parameters<typeof voterIp>[0];
    expect(voterIp(req('198.51.100.7', { 'x-real-ip': '192.0.2.1', 'x-forwarded-for': '192.0.2.2' }))).toBe('198.51.100.7');
    expect(voterIp(req('::ffff:127.0.0.1', { 'x-real-ip': '192.0.2.1' }))).toBe('192.0.2.1');
    expect(voterIp(req('::1', { 'x-real-ip': ['192.0.2.1', '192.0.2.2'] }))).toBe('::1');
  });
});
