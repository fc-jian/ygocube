import type { CardInfo, GuessCardRef, GuessOpeningHint, GuessRoomSummary } from './index';

export const DG_DEFAULT_SECONDS = 120;
export const DG_DEFAULT_ROUND_SECONDS = 180;
export const DG_MIN_SECONDS = 10;
export const DG_MAX_SECONDS = 600;
export const DG_GUESS_COOLDOWN_MS = 1000;
export const DG_WIDTH = 800;
export const DG_HEIGHT = 600;
export const DG_BRUSH_WIDTHS = [2, 5, 10, 18] as const;
export const DG_MAX_STROKES = 500;
export const DG_MAX_POINTS = 10_000;

export interface DgSettings {
  roundSeconds?: number;
  drawSeconds: number;
  guessSeconds: number;
  hintsEnabled: boolean;
}

export type DgMode = 'classic' | 'relay';

export interface DgRoomSummary extends GuessRoomSummary {
  mode: DgMode;
}

export interface DgCreateRequest extends Partial<DgSettings> {
  name: string;
  playerId: string;
  poolId: number;
  mode?: DgMode;
}

export type DgPoint = [x: number, y: number];
export type DgBrushWidth = typeof DG_BRUSH_WIDTHS[number];

export interface DgStroke {
  color: string;
  width: DgBrushWidth;
  points: DgPoint[];
}

export interface DgDrawing {
  strokes: DgStroke[];
}

export interface DgLiveDrawing extends DgDrawing {
  revision: string | null;
}

export interface DgDrawingPosition {
  strokeIndex: number;
  pointIndex: number;
}

export interface DgDrawingPatch extends DgDrawing, DgDrawingPosition {
  baseRevision: string | null;
  revision: string;
}

/** Replace the drawing suffix while keeping the prefix at the given position. */
export function applyDgDrawingPatch(drawing: DgDrawing, patch: DgDrawingPatch): DgLiveDrawing | null {
  const { strokeIndex, pointIndex, revision } = patch;
  if (strokeIndex > drawing.strokes.length) return null;
  const strokes = drawing.strokes.slice(0, strokeIndex);
  if (pointIndex > 0) {
    const previous = drawing.strokes[strokeIndex];
    const [first, ...rest] = patch.strokes;
    if (!previous || !first || pointIndex > previous.points.length
      || previous.color !== first.color || previous.width !== first.width) return null;
    strokes.push({ ...first, points: [...previous.points.slice(0, pointIndex), ...first.points] }, ...rest);
  } else {
    strokes.push(...patch.strokes);
  }
  const points = strokes.reduce((total, stroke) => total + stroke.points.length, 0);
  return strokes.length <= DG_MAX_STROKES && points <= DG_MAX_POINTS ? { revision, strokes } : null;
}

export type DgActionRequest =
  | { action: 'start' }
  | { action: 'leave' }
  | { action: 'guess'; turn: number; code: number }
  | { action: 'next' | 'finish'; turn: number }
  | ({ action: 'relay-submit'; round: number; step: number } & (
    { code: number; drawing?: DgDrawing } | { code?: never; drawing: DgDrawing }
  ))
  | { action: 'relay-reveal'; round: number; chain: number }
  | { action: 'relay-next'; round: number }
  | { action: 'relay-finish'; round: number };

export interface DgLastGuess {
  card: GuessCardRef;
  correct: boolean;
  at: number;
}

export interface DgSolve {
  playerId: string;
  points: number;
}

export interface DgTurnView {
  number: number;
  drawerId: string;
  hasDrawing: boolean;
  answer: CardInfo | null;
  hintAt: number | null;
  hint: GuessOpeningHint | null;
  solves: DgSolve[];
  drawerPoints: number;
}

export interface DgRelayPoints {
  guesses: number;
  drawings: number;
}

export type DgRelayStepAction = 'opening' | 'guess' | 'draw' | 'combined';

export type DgRelayView = {
  kind: 'active';
  round: number;
  step: number;
  stepCount: number;
  action: DgRelayStepAction;
  submittedCount: number;
  viewerSubmitted: boolean;
  choices: CardInfo[];
  prompt: GuessCardRef | null;
  hasIncomingDrawing: boolean;
} | {
  kind: 'reveal';
  round: number;
  revealedCount: number;
};

export interface DgRelayChainView {
  answer: CardInfo;
  steps: {
    playerId: string;
    action: DgRelayStepAction;
    prompt: GuessCardRef | null;
    hasDrawing: boolean;
    guess: GuessCardRef | null;
    correct: boolean | null;
    receivedFromStep: number | null;
  }[];
}

export interface DgRoomView extends DgRoomSummary {
  version: number;
  phase: 'lobby' | 'drawing' | 'guessing' | 'reveal' | 'relay' | 'relay_reveal' | 'finished';
  settings: DgSettings;
  serverNow: number;
  deadlineAt: number | null;
  hostId: string | null;
  players: { playerId: string; score: number; relayPoints?: DgRelayPoints }[];
  turn: DgTurnView | null;
  relay: DgRelayView | null;
  viewerId: string | null;
  viewerLastGuess: DgLastGuess | null;
}

export interface DgSession {
  token: string;
  room: DgRoomView;
}
