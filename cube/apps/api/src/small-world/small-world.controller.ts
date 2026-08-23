import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import type { SmallWorldCalculateRequest, SmallWorldCalculationResponse } from '@ygocube/shared';
import { Public } from '../auth/auth.guard';
import { SmallWorldService } from './small-world.service';

const MAX_CODES_PER_ZONE = 500;

function badInput(field: keyof SmallWorldCalculateRequest, reason: string): never {
  throw new BadRequestException({
    code: 'BAD_SMALL_WORLD_INPUT',
    details: { field, reason },
  });
}

function parseCodes(body: unknown, field: keyof SmallWorldCalculateRequest): number[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    badInput(field, 'expected a JSON object');
  }
  const value = (body as Record<string, unknown>)[field];
  if (!Array.isArray(value) || value.length > MAX_CODES_PER_ZONE) {
    badInput(field, `expected an array of at most ${MAX_CODES_PER_ZONE} codes`);
  }
  if (value.some((code) => typeof code !== 'number' || !Number.isSafeInteger(code) || code <= 0)) {
    badInput(field, 'codes must be positive safe integers');
  }
  return value as number[];
}

@Controller('tools/small-world')
export class SmallWorldController {
  constructor(private smallWorld: SmallWorldService) {}

  @Public()
  @Post('calculate')
  calculate(@Body() body: unknown): SmallWorldCalculationResponse {
    const deckCodes = parseCodes(body, 'deckCodes');
    const handCodes = parseCodes(body, 'handCodes');
    return this.smallWorld.calculate(deckCodes, handCodes);
  }
}
