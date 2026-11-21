import { Injectable } from '@nestjs/common';
import { DraftCopyAllowance, type DeckIssue, type MatchDeckWarning } from '@ygocube/shared';
import { loadState, logEvent, getConfig, pickedCards, persistMeta, DeckState, withEventTransaction } from '../events/events.service';
import { CardInfo, CardsService, isExtraDeckType } from '../cards/cards.service';
import { MatchesService } from '../matches/matches.service';
import { getDb } from '../db';

export class DeckInvalidError extends Error {
  constructor(public details: string[]) {
    super('DECK_INVALID');
  }
}

// Exact comparator used by YGOPro's deck editor BUTTON_SORT_DECK
// (DataManager::deck_sort_lv). This is deliberately the single canonical sort;
// attack/defense/name/id are search-result options in YGOPro, not deck-order actions.
export function compareCardsLikeYgopro(a: CardInfo, b: CardInfo): number {
  const categoryA = a.type & 0x7;
  const categoryB = b.type & 0x7;
  if (categoryA !== categoryB) return categoryA - categoryB;
  if (categoryA === 1) {
    const typeA = a.type & 0x48020c0 ? (a.type & 0x48020c1) >>> 0 : (a.type & 0x31) >>> 0;
    const typeB = b.type & 0x48020c0 ? (b.type & 0x48020c1) >>> 0 : (b.type & 0x31) >>> 0;
    if (typeA !== typeB) return typeA - typeB;
    if (a.level !== b.level) return b.level - a.level;
    if (a.atk !== b.atk) return b.atk - a.atk;
    if (a.def !== b.def) return b.def - a.def;
    return a.code - b.code;
  }
  const typeA = (a.type & 0xfffffff8) >>> 0;
  const typeB = (b.type & 0xfffffff8) >>> 0;
  return typeA - typeB || a.code - b.code;
}

// Deck building: move/lock/unlock, validation, timeout auto-fix, ydk export (dev_docs/05 §4).
@Injectable()
export class DecksService {
  constructor(private cards: CardsService, private matches?: MatchesService) {}

  // The pool/deck still stores the exact printed code, while YGOPro's rules
  // identity (datas.alias) is used only for copy-limit accounting.
  private copyAllowance(state: ReturnType<typeof loadState>, playerId: string, used: number[] = []): DraftCopyAllowance {
    const cfg = getConfig(state);
    return new DraftCopyAllowance(pickedCards(state, playerId), cfg.maxCopies ?? 3, cfg.draftFormat === 'edison_e3',
      (code) => this.cards.canonicalCode(code), used);
  }

  private deckOf(state: ReturnType<typeof loadState>, playerId: string): DeckState {
    return state.decks[playerId] ?? { main: [], extra: [], side: [], lockedAt: null, status: 'building' };
  }

  move(
    tid: number,
    playerId: string,
    card: number,
    from: 'main' | 'extra' | 'side' | 'pool',
    to: 'main' | 'extra' | 'side' | 'pool',
    index?: number,
    fromIndex?: number,
  ): void {
    if (index !== undefined && (!Number.isInteger(index) || index < 0)) throw new Error('BAD_PAYLOAD');
    if (fromIndex !== undefined && (!Number.isInteger(fromIndex) || fromIndex < 0)) throw new Error('BAD_PAYLOAD');
    const state = loadState(tid);
    if (state.status !== 'deckbuilding' && state.status !== 'drafting') throw new Error('WRONG_PHASE');
    const deck = this.deckOf(state, playerId);
    if (deck.lockedAt) throw new Error('LOCKED');
    const ci = this.cards.get(card);
    if (!ci && from !== 'pool') throw new Error('CARD_NOT_AVAILABLE');
    // 选牌池校验：from=pool 的卡必须属于该玩家已选卡（防绕过选牌直接塞卡，dev_docs/05 §4）
    if (from === 'pool') {
      if (this.copyAllowance(state, playerId, [...deck.main, ...deck.extra, ...deck.side]).rejection(card)) throw new Error('CARD_NOT_IN_POOL');
    }
    if (to === 'main' && ci && this.cards.isExtraDeck(card)) throw new Error('WRONG_ZONE');
    if (to === 'extra' && ci && !this.cards.isExtraDeck(card)) throw new Error('WRONG_ZONE');
    const newDeck: DeckState = { ...deck, main: [...deck.main], extra: [...deck.extra], side: [...deck.side] };
    const zones: Record<string, number[]> = { main: newDeck.main, extra: newDeck.extra, side: newDeck.side };
    let removedIndex: number | undefined;
    if (from !== 'pool') {
      const src = zones[from];
      const i = fromIndex !== undefined ? fromIndex : src.indexOf(card);
      if (i >= 0 && src[i] !== card) throw new Error('CARD_NOT_IN_ZONE');
      if (i < 0) throw new Error('CARD_NOT_IN_ZONE');
      removedIndex = i;
      src.splice(i, 1);
    }
    if (to === 'pool') {
      // 移出构筑：从所在区域移除，回到未使用区（卡池）
      this.save(tid, playerId, newDeck);
      return;
    }
    const dst = zones[to];
    let requested = index ?? dst.length;
    if (from === to && removedIndex !== undefined && removedIndex < requested) requested--;
    const pos = Math.max(0, Math.min(requested, dst.length));
    dst.splice(pos, 0, card);
    this.save(tid, playerId, newDeck);
  }

  sort(tid: number, playerId: string): void {
    const state = loadState(tid);
    if (state.status !== 'deckbuilding' && state.status !== 'drafting') throw new Error('WRONG_PHASE');
    const deck = this.deckOf(state, playerId);
    if (deck.lockedAt) throw new Error('LOCKED');
    const sortZone = (codes: number[]) => [...codes].sort((a, b) => {
      const ca = this.cards.get(a);
      const cb = this.cards.get(b);
      if (!ca || !cb) return ca ? -1 : (cb ? 1 : 0);
      return compareCardsLikeYgopro(ca, cb);
    });
    this.save(tid, playerId, {
      ...deck,
      main: sortZone(deck.main),
      extra: sortZone(deck.extra),
      side: sortZone(deck.side),
    });
  }

  shuffleMain(tid: number, playerId: string): void {
    const state = loadState(tid);
    if (state.status !== 'deckbuilding') throw new Error('WRONG_PHASE');
    const deck = this.deckOf(state, playerId);
    if (deck.lockedAt) throw new Error('LOCKED');
    const main = [...deck.main];
    for (let i = main.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [main[i], main[j]] = [main[j], main[i]];
    }
    this.save(tid, playerId, { ...deck, main });
  }

  lock(tid: number, playerId: string): void {
    const state = loadState(tid);
    if (state.status !== 'deckbuilding') throw new Error('WRONG_PHASE');
    if (state.frozen) throw new Error('FROZEN');
    const deck = this.deckOf(state, playerId);
    if (deck.lockedAt) throw new Error('ALREADY_LOCKED');
    const errors = this.validate(state, deck, playerId);
    if (errors.length) {
      const err = new DeckInvalidError(errors);
      throw err;
    }
    this.save(tid, playerId, { ...deck, lockedAt: new Date().toISOString(), status: 'locked' });
    this.checkAllLocked(tid);
  }

  unlock(tid: number, playerId: string): void {
    const state = loadState(tid);
    if (state.status !== 'deckbuilding') throw new Error('WRONG_PHASE');
    if (state.frozen) throw new Error('FROZEN');
    const deck = this.deckOf(state, playerId);
    this.save(tid, playerId, { ...deck, lockedAt: null, status: 'building' });
  }

  issues(state: ReturnType<typeof loadState>, playerId: string, deck = this.deckOf(state, playerId)): DeckIssue[] {
    const cfg = getConfig(state);
    const issues: DeckIssue[] = [];
    if (deck.main.length < cfg.mainMin) {
      issues.push({ zone: 'main', reason: 'too-few', actual: deck.main.length, limit: cfg.mainMin });
    }
    const limits = { main: cfg.mainMax, extra: cfg.extraMax, side: cfg.sideMax };
    const extraCards = new Set(this.cards.getMany([...deck.main, ...deck.extra]).filter((c) => isExtraDeckType(c.type)).map((c) => c.code));
    const allowance = this.copyAllowance(state, playerId);
    for (const zone of ['main', 'extra', 'side'] as const) {
      if (deck[zone].length > limits[zone]) {
        issues.push({ zone, reason: 'too-many', actual: deck[zone].length, limit: limits[zone] });
      }
      for (const code of deck[zone]) {
        if (zone !== 'side' && extraCards.has(code) !== (zone === 'extra')) {
          issues.push({ zone, reason: 'wrong-zone', code });
        }
        if (!allowance.take(code)) {
          const reason = allowance.rejection(code)!;
          issues.push({ zone, reason, code });
        }
      }
    }
    return issues;
  }

  validate(state: ReturnType<typeof loadState>, deck: DeckState, playerId: string): string[] {
    return this.issueMessages(this.issues(state, playerId, deck), getConfig(state).maxCopies ?? 3);
  }

  private issueMessages(issues: DeckIssue[], maxCopies: number): string[] {
    const errors = issues.map((issue) => {
      switch (issue.reason) {
        case 'too-few': return `${issue.zone} below minimum (${issue.actual} < ${issue.limit})`;
        case 'too-many': return `${issue.zone} above maximum (${issue.actual} > ${issue.limit})`;
        case 'wrong-zone': return issue.zone === 'main' ? `extra-deck card ${issue.code} in main` : `main-deck card ${issue.code} in extra`;
        case 'name_limit': return `more than ${maxCopies} copies of ${issue.code}`;
        case 'quantity': return `more copies of ${issue.code} than drafted`;
        case 'unpicked': return `card ${issue.code} not in picked pool`;
      }
    });
    return [...new Set(errors)];
  }

  // timeout auto-fix: random fill/remove to legal (dev_docs/05 §4)
  autoFix(tid: number, playerId: string): void {
    const state = loadState(tid);
    if (state.frozen) throw new Error('FROZEN');
    const deck = this.deckOf(state, playerId);
    const cfg = getConfig(state);
    const pool = pickedCards(state, playerId);
    const newDeck: DeckState = { ...deck, main: [...deck.main], extra: [...deck.extra], side: [...deck.side] };
    const shuffled = <T>(items: T[]): T[] => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    };
    // First discard unpicked, wrong-zone, and canonical-copy-overflow cards.
    // This makes the timeout/admin repair legal even when a client left a
    // partially invalid deck in the event log.
    let allowance = this.copyAllowance(state, playerId);
    const retain = (codes: number[], zone: 'main' | 'extra' | 'side'): number[] => shuffled(codes).filter((c) => {
      if (zone === 'main' && this.cards.isExtraDeck(c)) return false;
      if (zone === 'extra' && !this.cards.isExtraDeck(c)) return false;
      return allowance.take(c);
    });
    newDeck.main = retain(newDeck.main, 'main');
    newDeck.extra = retain(newDeck.extra, 'extra');
    newDeck.side = retain(newDeck.side, 'side');
    // Keep each zone within its hard capacity before filling available slots.
    newDeck.main = newDeck.main.slice(0, cfg.mainMax);
    newDeck.extra = newDeck.extra.slice(0, cfg.extraMax);
    newDeck.side = newDeck.side.slice(0, cfg.sideMax);
    allowance = this.copyAllowance(state, playerId, [...newDeck.main, ...newDeck.extra, ...newDeck.side]);
    for (const c of [...new Set(pool)]) {
      const isExtra = this.cards.isExtraDeck(c);
      const zone = isExtra ? newDeck.extra : newDeck.main;
      const limit = isExtra ? cfg.extraMax : cfg.mainMax;
      while (zone.length < limit && allowance.take(c)) zone.push(c);
    }
    newDeck.main = newDeck.main.slice(0, cfg.mainMax);
    newDeck.extra = newDeck.extra.slice(0, cfg.extraMax);
    newDeck.side = newDeck.side.slice(0, cfg.sideMax);
    if (newDeck.main.length < cfg.mainMin) {
      // random removal won't help; leave as-is and log (pool may be too small)
    }
    this.save(tid, playerId, { ...newDeck, lockedAt: new Date().toISOString(), status: 'locked' }, 'system');
  }

  validationReport(tid: number): MatchDeckWarning[] {
    const state = loadState(tid);
    const warnings: MatchDeckWarning[] = [];
    for (const player of state.players) {
      if (player.eliminated || player.withdrawn) continue;
      const issues = this.issues(state, player.playerId);
      if (!issues.length) continue;
      const { mainShortfall, movedToSide, returnedToPool } = this.planMatchDeck(state, player.playerId, false);
      warnings.push({ playerId: player.playerId, displayName: player.displayName, issues, mainShortfall, movedToSide,
        returnedToPool, errors: this.issueMessages(issues, getConfig(state).maxCopies ?? 3) });
    }
    return warnings;
  }

  repairForMatches(tid: number, playerId: string): { disqualified: boolean; movedToSide: number; returnedToPool: number } {
    return withEventTransaction(tid, () => {
      const state = loadState(tid);
      if (state.frozen) throw new Error('FROZEN');
      const { main, extra, side, mainShortfall, movedToSide, returnedToPool } = this.planMatchDeck(state, playerId, true);
      this.save(tid, playerId, { main, extra, side, lockedAt: new Date().toISOString(), status: 'locked' }, 'system');
      if (mainShortfall > 0) {
        getDb().prepare('UPDATE tournament_players SET eliminated=1 WHERE tournament_id=? AND player_id=?').run(tid, playerId);
        logEvent(tid, 'player', 'player_dsq', { playerId, reason: `main below minimum (${main.length} < ${getConfig(state).mainMin})` }, 'system');
        persistMeta(tid);
      }
      return { disqualified: mainShortfall > 0, movedToSide, returnedToPool };
    });
  }

  // Choosing which overflow copy to move changes card order, but never the counts shown at preflight.
  private planMatchDeck(state: ReturnType<typeof loadState>, playerId: string, randomize: boolean) {
    const cfg = getConfig(state);
    const allowance = this.copyAllowance(state, playerId);
    const source = this.deckOf(state, playerId);
    let returnedToPool = 0;
    let movedToSide = 0;
    const legalCopies = (codes: number[]) => codes.filter((code) => {
      if (!allowance.take(code)) {
        returnedToPool++;
        return false;
      }
      return true;
    });
    let main = legalCopies(source.main);
    let extra = legalCopies(source.extra);
    let side = legalCopies(source.side);
    const shuffle = <T>(items: T[]): T[] => {
      if (!randomize) return items;
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    };
    const overflowToSide = (codes: number[]) => {
      for (const code of shuffle(codes)) {
        if (side.length < cfg.sideMax) {
          side.push(code);
          movedToSide++;
        } else returnedToPool++;
      }
    };

    const wrongMain = main.filter((c) => this.cards.isExtraDeck(c));
    main = main.filter((c) => !this.cards.isExtraDeck(c));
    for (const code of shuffle(wrongMain)) {
      if (extra.length < cfg.extraMax) extra.push(code);
      else overflowToSide([code]);
    }
    const wrongExtra = extra.filter((c) => !this.cards.isExtraDeck(c));
    extra = extra.filter((c) => this.cards.isExtraDeck(c));
    for (const code of shuffle(wrongExtra)) {
      if (main.length < cfg.mainMax) main.push(code);
      else overflowToSide([code]);
    }
    const overflowIndex = (length: number) => randomize ? Math.floor(Math.random() * length) : length - 1;
    while (main.length > cfg.mainMax) overflowToSide(main.splice(overflowIndex(main.length), 1));
    while (extra.length > cfg.extraMax) overflowToSide(extra.splice(overflowIndex(extra.length), 1));
    while (side.length > cfg.sideMax) {
      side.splice(overflowIndex(side.length), 1);
      returnedToPool++;
    }
    return { main, extra, side, mainShortfall: Math.max(0, cfg.mainMin - main.length), movedToSide, returnedToPool };
  }

  private checkAllLocked(tid: number): void {
    const state = loadState(tid);
    if (state.status !== 'deckbuilding') return;
    // Even when everybody has locked, an administrator must explicitly start
    // matches so the compliance preview/confirmation cannot be bypassed.
  }

  private save(tid: number, playerId: string, deck: DeckState, actor?: string): void {
    withEventTransaction(tid, () => {
      logEvent(tid, 'deck', 'deck', { playerId, deck }, actor ?? playerId);
      persistMeta(tid);
    });
  }

  ydk(tid: number, playerId: string): string {
    const state = loadState(tid);
    const deck = this.deckOf(state, playerId);
    const lines = ['#created by YGO Cube', '#main'];
    for (const c of [...deck.main, ...deck.extra]) lines.push(String(c));
    lines.push('!side');
    for (const c of deck.side) lines.push(String(c));
    return lines.join('\n') + '\n';
  }
}
