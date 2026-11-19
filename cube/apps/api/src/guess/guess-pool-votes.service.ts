import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { DEFAULT_GUESS_POOL_VOTE_SORT } from '@ygocube/shared';
import type { CardSearchParams, GuessCardPage, GuessPoolCardVotes, GuessPoolProposalPage, GuessPoolProposals, GuessPoolVote, GuessPoolVoteSort } from '@ygocube/shared';
import { createHmac, randomBytes } from 'node:crypto';
import { CardsService, TYPE_TOKEN } from '../cards/cards.service';
import { getDb } from '../db';
import { GuessPoolsService } from './guess-pools.service';

const DAY = 86_400_000;
const DAILY_PROPOSALS = 10;
// Weights for likes and dislikes in the catalog's ascending order.
const VOTE_SORT_WEIGHTS: Record<Exclude<GuessPoolVoteSort, 'relevance'>, [number, number]> = {
  'net-dislikes-desc': [1, -1],
  'likes-desc': [-1, 0],
  'likes-asc': [1, 0],
  'dislikes-desc': [0, -1],
  'dislikes-asc': [0, 1],
};

@Injectable()
export class GuessPoolVotesService {
  constructor(private readonly pools: GuessPoolsService, private readonly cards: CardsService) {}

  private identity(ip: string): string {
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)')
      .run('guess_vote_ip_salt', randomBytes(32).toString('hex'), new Date().toISOString());
    const salt = db.prepare('SELECT value FROM app_settings WHERE key = ?').pluck().get('guess_vote_ip_salt') as string;
    return createHmac('sha256', Buffer.from(salt, 'hex')).update(`guess-vote-ip:${ip}`).digest('hex');
  }

  withVotes(poolId: number, page: GuessCardPage, ip: string): GuessCardPage {
    if (!page.cards.length) return page;
    const codes = page.cards.map((card) => card.code);
    const rows = getDb().prepare(`
      SELECT code, SUM(vote = 'like') AS likes, SUM(vote = 'dislike') AS dislikes,
        MAX(CASE WHEN voter_hash = ? THEN vote END) AS mine
      FROM guess_pool_card_votes WHERE pool_id = ? AND code IN (${codes.map(() => '?').join(',')}) GROUP BY code
    `).all(this.identity(ip), poolId, ...codes) as (GuessPoolCardVotes & { code: number })[];
    const votes = new Map(rows.map(({ code, ...value }) => [code, value]));
    return { ...page, cards: page.cards.map((card) => ({
      ...card, votes: votes.get(card.code) ?? { likes: 0, dislikes: 0, mine: null },
    })) };
  }

  browse(poolId: number, params: CardSearchParams, ip: string, voteSort?: GuessPoolVoteSort): GuessCardPage {
    if (voteSort !== undefined && params.sort !== 'relevance') throw new BadRequestException({ code: 'BAD_PAYLOAD' });
    const sort = voteSort ?? (params.sort === 'relevance' ? DEFAULT_GUESS_POOL_VOTE_SORT : 'relevance');
    let order: Map<number, number> | undefined;
    if (sort !== 'relevance') {
      const rows = getDb().prepare(`
        SELECT code, SUM(CASE WHEN vote = 'like' THEN ? ELSE ? END) AS weight
        FROM guess_pool_card_votes WHERE pool_id = ? GROUP BY code
      `).all(...VOTE_SORT_WEIGHTS[sort], poolId) as { code: number; weight: number }[];
      order = new Map(rows.map(({ code, weight }) => [code, weight]));
    }
    return this.withVotes(poolId, this.pools.browse(poolId, params, order), ip);
  }

  vote(poolId: number, code: number, vote: GuessPoolVote | null, ip: string): GuessPoolCardVotes {
    const pool = this.pools.get(poolId);
    const card = this.cards.get(code);
    if (!card || (card.type & TYPE_TOKEN) || (pool.codes !== null && !pool.codes.includes(code))) {
      throw new BadRequestException({ code: 'GUESS_CARD_NOT_IN_POOL' });
    }
    const db = getDb();
    return db.transaction(() => {
      const voter = this.identity(ip);
      if (vote === null) {
        db.prepare('DELETE FROM guess_pool_card_votes WHERE pool_id = ? AND code = ? AND voter_hash = ?').run(poolId, code, voter);
      } else {
        db.prepare(`
          INSERT INTO guess_pool_card_votes(pool_id, code, voter_hash, vote, created_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (pool_id, code, voter_hash) DO UPDATE SET vote = excluded.vote
        `).run(poolId, code, voter, vote, new Date().toISOString());
      }
      return this.withVotes(poolId, { cards: [card], totalCount: 1, totalPages: 1, hasMore: false }, ip).cards[0].votes!;
    }).immediate();
  }

  private candidates(poolId: number): Set<number> {
    const { codes } = this.pools.get(poolId);
    if (codes === null) return new Set();
    const members = new Set(codes.map((code) => this.cards.artworkCode(code)));
    return new Set(this.cards.poolCodes().map((code) => this.cards.artworkCode(code)).filter((code) => !members.has(code)));
  }

  searchProposals(poolId: number, params: CardSearchParams, ip: string): GuessCardPage {
    if (params.sort !== 'relevance' || Object.values(params.filters).some((value) => value !== undefined)) {
      throw new BadRequestException({ code: 'GUESS_FILTERS_DISABLED' });
    }
    const result = this.cards.searchCatalogNames(params, this.candidates(poolId));
    const voted = this.viewerBallots(poolId, ip);
    return { ...result, cards: result.cards.map((card) => ({ ...card, proposedByViewer: voted.has(card.code) })) };
  }

  private viewerBallots(poolId: number, ip: string): Set<number> {
    return new Set(getDb().prepare('SELECT code FROM guess_pool_proposal_ballots WHERE pool_id=? AND voter_hash=?')
      .pluck().all(poolId, this.identity(ip)) as number[]);
  }

  private proposalStatus(poolId: number, ip: string, candidates: ReadonlySet<number>): Omit<GuessPoolProposals, 'top'> {
    const voteDate = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
    const nextVoteAt = new Date(Date.parse(`${voteDate}T00:00:00+08:00`) + DAY).toISOString();
    const db = getDb();
    const votedCodes = db.prepare('SELECT code FROM guess_pool_proposal_ballots WHERE pool_id=? AND voter_hash=? AND vote_date=? ORDER BY created_at,code')
      .pluck().all(poolId, this.identity(ip), voteDate) as number[];
    const remainingVotes = Math.max(0, DAILY_PROPOSALS - votedCodes.length);
    return { voteDate, nextVoteAt, votedCode: votedCodes[0] ?? null, votedCodes, dailyLimit: DAILY_PROPOSALS,
      remainingVotes, hasCandidates: candidates.size > 0, canVote: candidates.size > 0 && remainingVotes > 0 };
  }

  private rankedProposals(poolId: number, candidates: ReadonlySet<number>): { code: number; votes: number }[] {
    return (getDb().prepare(`SELECT code, COUNT(*) AS votes FROM guess_pool_proposal_ballots WHERE pool_id = ?
      GROUP BY code ORDER BY votes DESC, code ASC`).all(poolId) as { code: number; votes: number }[])
      .filter(({ code }) => candidates.has(code));
  }

  proposals(poolId: number, ip: string): GuessPoolProposals {
    const candidates = this.candidates(poolId);
    const voted = this.viewerBallots(poolId, ip);
    const top = this.rankedProposals(poolId, candidates).slice(0, 5)
      .map(({ code, votes }) => ({ card: this.cards.get(code)!, votes, voted: voted.has(code) }));
    return { top, ...this.proposalStatus(poolId, ip, candidates) };
  }

  ranking(poolId: number, params: CardSearchParams, ip: string): GuessPoolProposalPage {
    if (params.sort !== 'relevance' || Object.values(params.filters).some((value) => value !== undefined)) {
      throw new BadRequestException({ code: 'GUESS_FILTERS_DISABLED' });
    }
    const candidates = this.candidates(poolId);
    const ranked = this.rankedProposals(poolId, candidates);
    const order = new Map(ranked.map(({ code }, index) => [code, index + 1]));
    const counts = new Map(ranked.map(({ code, votes }) => [code, votes]));
    const voted = this.viewerBallots(poolId, ip);
    const { cards, ...page } = this.cards.searchCatalogNames(params, new Set(order.keys()), order);
    return { ...page, ...this.proposalStatus(poolId, ip, candidates),
      proposals: cards.map((card) => ({ card, votes: counts.get(card.code)!, rank: order.get(card.code)!, voted: voted.has(card.code) })) };
  }

  propose(poolId: number, code: number, ip: string): GuessPoolProposals {
    return this.proposeMany(poolId, [code], ip);
  }

  proposeMany(poolId: number, codes: readonly number[], ip: string): GuessPoolProposals {
    if (codes.length < 1 || codes.length > DAILY_PROPOSALS || codes.some((code) => !Number.isSafeInteger(code) || code < 1)) {
      throw new BadRequestException({ code: 'BAD_PAYLOAD' });
    }
    // Validate the entire batch before writing, including shared daily quota.
    return getDb().transaction(() => {
      const candidates = this.candidates(poolId);
      const representatives = codes.map((code) => {
        const card = this.cards.get(code);
        if (!card || (card.type & TYPE_TOKEN)) throw new BadRequestException({ code: 'GUESS_INVALID_PROPOSAL' });
        return this.cards.artworkCode(code);
      });
      if (new Set(representatives).size !== representatives.length) throw new BadRequestException({ code: 'BAD_PAYLOAD' });
      if (representatives.some((code) => !candidates.has(code))) {
        throw new ConflictException({ code: 'GUESS_CARD_ALREADY_IN_POOL' });
      }
      const state = this.proposalStatus(poolId, ip, candidates);
      const voter = this.identity(ip);
      const voted = this.viewerBallots(poolId, ip);
      if (representatives.some((code) => voted.has(code))) {
        throw new ConflictException({ code: 'GUESS_PROPOSAL_ALREADY_VOTED' });
      }
      if (representatives.length > state.remainingVotes) throw new ConflictException({ code: 'GUESS_PROPOSAL_DAILY_LIMIT' });
      const insert = getDb().prepare(`
        INSERT INTO guess_pool_proposal_ballots(pool_id, code, voter_hash, vote_date, created_at) VALUES (?, ?, ?, ?, ?)
      `);
      const now = new Date().toISOString();
      for (const code of representatives) insert.run(poolId, code, voter, state.voteDate, now);
      return this.proposals(poolId, ip);
    }).immediate();
  }
}
