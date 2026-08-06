import { Injectable } from '@nestjs/common';
import { loadState, logEvent, getConfig, pickedCards, persistMeta, DeckState } from '../events/events.service';
import { CardsService } from '../cards/cards.service';
import { MatchesService } from '../matches/matches.service';

export class DeckInvalidError extends Error {
  constructor(public details: string[]) {
    super('DECK_INVALID');
  }
}

// Deck building: move/lock/unlock, validation, timeout auto-fix, ydk export (dev_docs/05 §4).
@Injectable()
export class DecksService {
  constructor(private cards: CardsService, private matches?: MatchesService) {}

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
  ): void {
    const state = loadState(tid);
    if (state.status !== 'deckbuilding' && state.status !== 'drafting') throw new Error('WRONG_PHASE');
    const deck = this.deckOf(state, playerId);
    if (deck.lockedAt) throw new Error('LOCKED');
    const ci = this.cards.get(card);
    if (!ci && from !== 'pool') throw new Error('CARD_NOT_AVAILABLE');
    // 选牌池校验：from=pool 的卡必须属于该玩家已选卡（防绕过选牌直接塞卡，dev_docs/05 §4）
    if (from === 'pool' && !pickedCards(state, playerId).includes(card)) throw new Error('CARD_NOT_IN_POOL');
    if (to === 'main' && ci && this.cards.isExtraDeck(card)) throw new Error('WRONG_ZONE');
    if (to === 'extra' && ci && !this.cards.isExtraDeck(card)) throw new Error('WRONG_ZONE');
    const newDeck: DeckState = { ...deck, main: [...deck.main], extra: [...deck.extra], side: [...deck.side] };
    const zones: Record<string, number[]> = { main: newDeck.main, extra: newDeck.extra, side: newDeck.side };
    if (from !== 'pool') {
      const src = zones[from];
      const i = src.indexOf(card);
      if (i < 0) throw new Error('CARD_NOT_IN_ZONE');
      src.splice(i, 1);
    }
    if (to === 'pool') {
      // 移出构筑：从所在区域移除，回到未使用区（卡池）
      this.save(tid, playerId, newDeck);
      return;
    }
    const dst = zones[to];
    const pos = index !== undefined && index <= dst.length ? index : dst.length;
    dst.splice(pos, 0, card);
    this.save(tid, playerId, newDeck);
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

  validate(state: ReturnType<typeof loadState>, deck: DeckState, playerId: string): string[] {
    const cfg = getConfig(state);
    const errors: string[] = [];
    if (deck.main.length < cfg.mainMin) errors.push(`main below minimum (${deck.main.length} < ${cfg.mainMin})`);
    if (deck.main.length > cfg.mainMax) errors.push(`main above maximum (${deck.main.length} > ${cfg.mainMax})`);
    if (deck.extra.length > cfg.extraMax) errors.push(`extra above maximum (${deck.extra.length} > ${cfg.extraMax})`);
    if (deck.side.length > cfg.sideMax) errors.push(`side above maximum (${deck.side.length} > ${cfg.sideMax})`);
    for (const c of deck.main) {
      if (this.cards.isExtraDeck(c)) errors.push(`extra-deck card ${c} in main`);
    }
    // 卡组必须是已选卡的子集（dev_docs/05 §4）
    const picked = new Set(pickedCards(state, playerId));
    const counts = new Map<number, number>();
    for (const c of [...deck.main, ...deck.extra, ...deck.side]) {
      if (!picked.has(c)) {
        errors.push(`card ${c} not in picked pool`);
        continue;
      }
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    const maxCopies = Number(cfg.maxCopies ?? 3);
    for (const [c, n] of counts) {
      if (n > maxCopies) errors.push(`more than ${maxCopies} copies of ${c}`);
    }
    return errors;
  }

  // timeout auto-fix: random fill/remove to legal (dev_docs/05 §4)
  autoFix(tid: number, playerId: string): void {
    const state = loadState(tid);
    const deck = this.deckOf(state, playerId);
    const cfg = getConfig(state);
    const pool = pickedCards(state, playerId);
    const newDeck: DeckState = { ...deck, main: [...deck.main], extra: [...deck.extra], side: [...deck.side] };
    // fill main from pool (respecting zone rules), trim overflows
    const mainSet = new Set(newDeck.main);
    const extraSet = new Set(newDeck.extra);
    const used = new Set([...newDeck.main, ...newDeck.extra, ...newDeck.side]);
    for (const c of pool) {
      if (newDeck.main.length >= cfg.mainMax) break;
      if (used.has(c)) continue;
      if (this.cards.isExtraDeck(c)) {
        if (extraSet.has(c)) continue;
      } else {
        newDeck.main.push(c);
        mainSet.add(c);
        used.add(c);
      }
    }
    newDeck.main = newDeck.main.slice(0, cfg.mainMax);
    newDeck.extra = newDeck.extra.slice(0, cfg.extraMax);
    newDeck.side = newDeck.side.slice(0, cfg.sideMax);
    if (newDeck.main.length < cfg.mainMin) {
      // random removal won't help; leave as-is and log (pool may be too small)
    }
    this.save(tid, playerId, { ...newDeck, lockedAt: new Date().toISOString(), status: 'locked' }, 'system');
  }

  private checkAllLocked(tid: number): void {
    const state = loadState(tid);
    if (state.status !== 'deckbuilding') return;
    const all = state.players.every((p) => state.decks[p.playerId]?.lockedAt);
    if (all) {
      logEvent(tid, 'tournament', 'phase', { status: 'matches', round: 1 }, 'system');
      persistMeta(tid);
      this.matches?.startRound(tid, 1, 'system');
    }
  }

  private save(tid: number, playerId: string, deck: DeckState, actor?: string): void {
    logEvent(tid, 'deck', 'deck', { playerId, deck }, actor ?? playerId);
    persistMeta(tid);
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
