import { randomInt } from 'node:crypto';
import type { CardInfo, DgRelayChainView, DgRelayPoints, DgRelayView, GuessCardRef } from '@ygocube/shared';

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

export function incomingDrawingVersion(chain: RelayChain, step: number): number | null {
  for (let index = step - 2; index >= 0; index--) {
    const version = chain.entries[index].drawingVersion;
    if (version !== null) return version;
  }
  return null;
}

/** Close a barrier, filling missing submissions before any drawing changes hands. */
export function closeRelayStep(round: RelayRound): boolean {
  for (const chain of round.chains) {
    if (round.step === 1) {
      chain.answer ??= chain.choices[0];
      chain.choices = [];
    }
    if (chain.entries.length < round.step) chain.entries.push({ guess: null, drawingVersion: null });
  }
  if (round.step === round.chains.length) return false;
  round.step++;
  return true;
}

function addPoint(player: RelayPlayer, kind: keyof DgRelayPoints) {
  player.relayPoints ??= { guesses: 0, drawings: 0 };
  player.relayPoints[kind]++;
  player.score++;
}

export function revealRelayChain(round: RelayRound, players: RelayPlayer[]): void {
  const chainIndex = round.revealedCount;
  const chain = round.chains[chainIndex];
  let lastArtist: RelayPlayer | undefined;
  chain.entries.forEach((entry, index) => {
    const player = players[(chainIndex + index) % players.length];
    if (entry.guess?.code === chain.answer!.code) {
      addPoint(player, 'guesses');
      if (lastArtist) addPoint(lastArtist, 'drawings');
    }
    if (entry.drawingVersion !== null) lastArtist = player;
  });
  round.revealedCount++;
}

export function activeRelayView(round: RelayRound, seat: number): DgRelayView {
  const chain = seat < 0 ? null : relayChainFor(round, seat);
  const viewerSubmitted = chain?.entries.length === round.step;
  return {
    kind: 'active', round: round.number, step: round.step,
    submittedCount: round.chains.filter(({ entries }) => entries.length === round.step).length,
    viewerSubmitted,
    choices: round.step === 1 && chain && !viewerSubmitted ? chain.choices : [],
    hasIncomingDrawing: chain !== null && incomingDrawingVersion(chain, round.step) !== null,
  };
}

export function revealedRelayView(round: RelayRound, players: readonly RelayPlayer[], chainNumber: number): DgRelayChainView {
  const chainIndex = chainNumber - 1;
  const chain = round.chains[chainIndex];
  const answer = chain.answer!;
  let lastDrawingStep: number | null = null;
  const steps = chain.entries.map((entry, index) => {
    const step = {
      playerId: players[(chainIndex + index) % players.length].playerId,
      hasDrawing: entry.drawingVersion !== null,
      guess: entry.guess,
      correct: entry.guess ? entry.guess.code === answer.code : null,
      receivedFromStep: lastDrawingStep,
    };
    if (step.hasDrawing) lastDrawingStep = index + 1;
    return step;
  });
  return { answer, steps };
}
