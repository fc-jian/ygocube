import { randomInt } from 'node:crypto';
import type { CardInfo, DgRelayChainView, DgRelayPoints, DgRelayStepAction, DgRelayView, GuessCardRef } from '@ygocube/shared';

export const RELAY_CHOICES = 3;

interface RelayEntry {
  guess: GuessCardRef | null;
  drawingVersion: number | null;
}

interface RelayChain {
  choices: CardInfo[];
  answer: CardInfo | null;
  entries: RelayEntry[];
}

export interface RelayRound {
  rules?: 'alternating';
  number: number;
  step: number;
  revealedCount: number;
  chains: RelayChain[];
}

interface RelayPlayer {
  playerId: string;
  score: number;
  relayPoints?: DgRelayPoints;
}

export function relayOffers(codes: number[], playerCount: number): number[][] {
  const deck = [...codes];
  let cursor = 0;
  return Array.from({ length: playerCount }, () => {
    // Deal disjoint choices until fewer than three undealt cards remain.
    if (cursor + RELAY_CHOICES > deck.length) cursor = 0;
    const start = cursor;
    for (; cursor < start + RELAY_CHOICES; cursor++) {
      const swap = randomInt(cursor, deck.length);
      [deck[cursor], deck[swap]] = [deck[swap], deck[cursor]];
    }
    return deck.slice(start, cursor);
  });
}

export function relayChainFor(round: RelayRound, seat: number): RelayChain {
  const count = round.chains.length;
  return round.chains[(seat + count - (round.step - 1)) % count];
}

function relayStepCount(round: RelayRound): number {
  const count = round.chains.length;
  // End on a guess, before the chain returns to its first artist.
  return round.rules === 'alternating' ? count - count % 2 : count;
}

export function relayStepAction(round: RelayRound, step = round.step): DgRelayStepAction {
  if (step === 1) return 'opening';
  if (round.rules !== 'alternating') return 'combined';
  return step % 2 === 0 ? 'guess' : 'draw';
}

function relayPrompt(chain: RelayChain, step: number): GuessCardRef {
  for (let index = step - 2; index >= 0; index--) {
    const { guess } = chain.entries[index];
    if (guess) return guess;
  }
  const { code, name } = chain.answer!;
  return { code, name };
}

export function incomingDrawingVersion(chain: RelayChain, step: number): number | null {
  for (let index = step - 2; index >= 0; index--) {
    const version = chain.entries[index].drawingVersion;
    if (version !== null) return version;
  }
  return null;
}

/** Fill missing submissions before passing drawings or guesses to the next seat. */
export function closeRelayStep(round: RelayRound): boolean {
  for (const chain of round.chains) {
    if (round.step === 1) {
      chain.answer ??= chain.choices[0];
      chain.choices = [];
    }
    if (chain.entries.length < round.step) chain.entries.push({ guess: null, drawingVersion: null });
  }
  if (round.step === relayStepCount(round)) return false;
  round.step++;
  return true;
}

function addPoint(player: RelayPlayer, kind: keyof DgRelayPoints) {
  player.relayPoints ??= { guesses: 0, drawings: 0 };
  player.relayPoints[kind]++;
  player.score++;
}

function relayGuessCorrect(round: RelayRound, chain: RelayChain, guess: GuessCardRef | null, drawingStep: number | null): boolean | null {
  if (!guess) return null;
  if (round.rules !== 'alternating') return guess.code === chain.answer!.code;
  return drawingStep === null ? null : guess.code === relayPrompt(chain, drawingStep).code;
}

export function revealRelayChain(round: RelayRound, players: RelayPlayer[]): void {
  const chainIndex = round.revealedCount;
  const chain = round.chains[chainIndex];
  let lastDrawingStep: number | null = null;
  chain.entries.forEach((entry, index) => {
    const player = players[(chainIndex + index) % players.length];
    if (relayGuessCorrect(round, chain, entry.guess, lastDrawingStep)) {
      addPoint(player, 'guesses');
      if (lastDrawingStep !== null) addPoint(players[(chainIndex + lastDrawingStep - 1) % players.length], 'drawings');
    }
    if (entry.drawingVersion !== null) lastDrawingStep = index + 1;
  });
  round.revealedCount++;
}

export function activeRelayView(round: RelayRound, seat: number): DgRelayView {
  const chain = seat < 0 ? null : relayChainFor(round, seat);
  const viewerSubmitted = chain?.entries.length === round.step;
  const action = relayStepAction(round);
  return {
    kind: 'active', round: round.number, step: round.step, stepCount: relayStepCount(round), action,
    submittedCount: round.chains.filter(({ entries }) => entries.length === round.step).length,
    viewerSubmitted,
    choices: action === 'opening' && chain && !viewerSubmitted ? chain.choices : [],
    prompt: action === 'draw' && chain && !viewerSubmitted ? relayPrompt(chain, round.step) : null,
    hasIncomingDrawing: chain !== null && (action === 'guess' || action === 'combined')
      && incomingDrawingVersion(chain, round.step) !== null,
  };
}

export function revealedRelayView(round: RelayRound, players: readonly RelayPlayer[], chainNumber: number): DgRelayChainView {
  const chainIndex = chainNumber - 1;
  const chain = round.chains[chainIndex];
  const answer = chain.answer!;
  let lastDrawingStep: number | null = null;
  const steps = chain.entries.map((entry, index) => {
    const action = relayStepAction(round, index + 1);
    const step = {
      playerId: players[(chainIndex + index) % players.length].playerId,
      action,
      prompt: action === 'draw' ? relayPrompt(chain, index + 1) : null,
      hasDrawing: entry.drawingVersion !== null,
      guess: entry.guess,
      correct: relayGuessCorrect(round, chain, entry.guess, lastDrawingStep),
      receivedFromStep: action === 'guess' || action === 'combined' ? lastDrawingStep : null,
    };
    if (step.hasDrawing) lastDrawingStep = index + 1;
    return step;
  });
  return { answer, steps };
}
