import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import {
  DG_BRUSH_WIDTHS, DG_HEIGHT, DG_MAX_POINTS, DG_MAX_SECONDS, DG_MAX_STROKES, DG_MIN_SECONDS, DG_WIDTH,
  type DgActionRequest, type DgDrawing, type DgDrawingPatch, type DgPoint,
} from '@ygocube/shared';
import type { Response } from 'express';
import { Public } from '../auth/auth.guard';
import { parseCardSearchParams } from '../cards/search-params';
import { badPayload, integer, payload, playerId, text } from '../games/room-input';
import { DgService } from './dg.service';

function parseStrokes(strokes: unknown, minimum: number): DgDrawing['strokes'] {
  if (!Array.isArray(strokes) || strokes.length < minimum || strokes.length > DG_MAX_STROKES) badPayload();
  let count = 0;
  return strokes.map((stroke) => {
    const { color, width, points } = payload(stroke, ['color', 'width', 'points']);
    if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) badPayload();
    const brush = DG_BRUSH_WIDTHS.find((size) => size === width);
    if (brush === undefined || !Array.isArray(points) || points.length < 1) badPayload();
    count += points.length;
    if (count > DG_MAX_POINTS) badPayload();
    return {
      color,
      width: brush,
      points: points.map((point): DgPoint => {
        if (!Array.isArray(point) || point.length !== 2) badPayload();
        return [integer(point[0], 0, DG_WIDTH), integer(point[1], 0, DG_HEIGHT)];
      }),
    };
  });
}

function parseDrawing(value: unknown): DgDrawing {
  return { strokes: parseStrokes(payload(value, ['strokes']).strokes, 1) };
}

function drawingRevision(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) badPayload();
  return value;
}

function parseDrawingPatch(body: unknown): DgDrawingPatch {
  const { revision, baseRevision, strokeIndex, pointIndex, strokes } =
    payload(body, ['revision', 'baseRevision', 'strokeIndex', 'pointIndex', 'strokes']);
  if (revision === baseRevision) badPayload();
  return {
    revision: drawingRevision(revision),
    baseRevision: baseRevision === null ? null : drawingRevision(baseRevision),
    strokeIndex: integer(strokeIndex, 0, DG_MAX_STROKES),
    pointIndex: integer(pointIndex, 0, DG_MAX_POINTS),
    strokes: parseStrokes(strokes, 0),
  };
}

function positiveInteger(value: unknown): number {
  return integer(value, 1, Number.MAX_SAFE_INTEGER);
}

function pathNumber(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) badPayload();
  return positiveInteger(Number(value));
}

function parseAction(body: unknown): DgActionRequest {
  const { action } = payload(body, ['action', 'turn', 'code', 'drawing', 'round', 'step', 'chain']);
  switch (action) {
    case 'guess': {
      const { turn, code } = payload(body, ['action', 'turn', 'code']);
      return { action, turn: positiveInteger(turn), code: positiveInteger(code) };
    }
    case 'submit': {
      const { turn, drawing } = payload(body, ['action', 'turn', 'drawing']);
      return { action, turn: positiveInteger(turn), drawing: parseDrawing(drawing) };
    }
    case 'relay-submit': {
      const { round, step, code, drawing } = payload(body, ['action', 'round', 'step', 'code', 'drawing']);
      return { action, round: positiveInteger(round), step: positiveInteger(step), code: positiveInteger(code), drawing: parseDrawing(drawing) };
    }
    case 'relay-reveal': {
      const { round, chain } = payload(body, ['action', 'round', 'chain']);
      return { action, round: positiveInteger(round), chain: positiveInteger(chain) };
    }
    case 'relay-next':
    case 'relay-finish':
      return { action, round: positiveInteger(payload(body, ['action', 'round']).round) };
    case 'start':
    case 'leave':
      payload(body, ['action']);
      return { action };
    default:
      return badPayload();
  }
}

@Public()
@Controller('games/dg')
export class DgController {
  constructor(private readonly game: DgService) {}

  @Get('rooms')
  list() {
    return this.game.list();
  }

  @Post('rooms')
  create(@Body() body: unknown) {
    const { name, playerId: id, poolId, mode, drawSeconds, guessSeconds, hintsEnabled } =
      payload(body, ['name', 'playerId', 'poolId', 'mode', 'drawSeconds', 'guessSeconds', 'hintsEnabled']);
    if (hintsEnabled !== undefined && typeof hintsEnabled !== 'boolean') badPayload();
    if (mode !== undefined && mode !== 'classic' && mode !== 'relay') badPayload();
    return this.game.create({
      name: text(name, 48),
      playerId: playerId(id),
      poolId: integer(poolId, 0, Number.MAX_SAFE_INTEGER),
      mode,
      drawSeconds: drawSeconds === undefined ? undefined : integer(drawSeconds, DG_MIN_SECONDS, DG_MAX_SECONDS),
      guessSeconds: guessSeconds === undefined ? undefined : integer(guessSeconds, DG_MIN_SECONDS, DG_MAX_SECONDS),
      hintsEnabled,
    });
  }

  @Post('rooms/:roomId/join')
  join(@Param('roomId') roomId: string, @Body() body: unknown) {
    return this.game.join(roomId, playerId(payload(body, ['playerId']).playerId));
  }

  @Get('rooms/:roomId')
  state(@Param('roomId') roomId: string, @Headers('authorization') authorization?: string) {
    return this.game.state(roomId, authorization);
  }

  @Get('rooms/:roomId/cards')
  cards(
    @Param('roomId') roomId: string,
    @Headers('authorization') authorization: string | undefined,
    @Query() query: Record<string, unknown>,
  ) {
    return this.game.search(roomId, authorization, parseCardSearchParams(query));
  }

  @Get('rooms/:roomId/drawing/:turn')
  drawing(@Param('roomId') roomId: string, @Param('turn') turn: string) {
    return this.game.drawing(roomId, pathNumber(turn));
  }

  @Get('rooms/:roomId/drawing/:turn/live')
  liveDrawing(@Param('roomId') roomId: string, @Param('turn') turn: string) {
    return this.game.liveDrawing(roomId, pathNumber(turn));
  }

  @Post('rooms/:roomId/drawing/:turn/live')
  @HttpCode(200)
  updateDrawing(
    @Param('roomId') roomId: string, @Param('turn') turn: string,
    @Headers('authorization') authorization: string | undefined, @Body() body: unknown,
  ) {
    return this.game.updateDrawing(roomId, pathNumber(turn), authorization, parseDrawingPatch(body));
  }

  @Get('rooms/:roomId/drawing/:turn/stream')
  drawingStream(@Param('roomId') roomId: string, @Param('turn') turn: string, @Res() response: Response) {
    this.game.subscribeDrawing(roomId, pathNumber(turn), response);
  }

  @Get('rooms/:roomId/relay/:round/incoming/:step')
  incoming(
    @Param('roomId') roomId: string, @Param('round') round: string, @Param('step') step: string,
    @Headers('authorization') authorization?: string,
  ) {
    return this.game.relayIncoming(roomId, authorization, pathNumber(round), pathNumber(step));
  }

  @Get('rooms/:roomId/relay/:round/chains/:chain')
  relayResult(@Param('roomId') roomId: string, @Param('round') round: string, @Param('chain') chain: string) {
    return this.game.relayResult(roomId, pathNumber(round), pathNumber(chain));
  }

  @Get('rooms/:roomId/relay/:round/chains/:chain/drawings/:step')
  relayResultDrawing(
    @Param('roomId') roomId: string, @Param('round') round: string, @Param('chain') chain: string, @Param('step') step: string,
  ) {
    return this.game.relayResultDrawing(roomId, pathNumber(round), pathNumber(chain), pathNumber(step));
  }

  @Post('rooms/:roomId/action')
  @HttpCode(200)
  act(@Param('roomId') roomId: string, @Headers('authorization') authorization: string | undefined, @Body() body: unknown) {
    return this.game.act(roomId, authorization, parseAction(body));
  }
}
