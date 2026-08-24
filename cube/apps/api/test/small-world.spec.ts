import { BadRequestException } from '@nestjs/common';
import type { CardInfo } from '../src/cards/cards.service';
import { SmallWorldController } from '../src/small-world/small-world.controller';
import {
  enumerateSmallWorldPaths,
  isSmallWorldEligible,
  sharedSmallWorldProperty,
  SmallWorldService,
} from '../src/small-world/small-world.service';

function card(code: number, overrides: Partial<CardInfo> = {}): CardInfo {
  return {
    code,
    name: `测试卡 ${code}`,
    type: 0x21,
    desc: '',
    level: 4,
    lscale: 0,
    rscale: 0,
    linkMarkers: 0,
    race: 1,
    attribute: 1,
    atk: 1000,
    def: 1000,
    alias: 0,
    setCodes: [],
    setNames: [],
    ...overrides,
  };
}

describe('Small World calculation', () => {
  it('accepts exactly one shared property and rejects zero or multiple properties', () => {
    const base = card(1);
    expect(sharedSmallWorldProperty(base, card(2, { attribute: 2, level: 5, atk: 1500, def: 1200 }))).toBe('race');
    expect(sharedSmallWorldProperty(base, card(3, { attribute: 2, level: 4, atk: 1500, def: 1200 }))).toBeNull();
    expect(sharedSmallWorldProperty(base, card(4, { race: 2, attribute: 2, level: 5, atk: 1500, def: 1200 }))).toBeNull();
  });

  it('enumerates ordered hand → bridge → target paths and preserves zero stats', () => {
    const hand = card(10, { race: 1, attribute: 1, level: 4, atk: 0, def: 0 });
    const bridge = card(20, { race: 1, attribute: 2, level: 5, atk: 1500, def: 1200 });
    const target = card(30, { race: 2, attribute: 2, level: 6, atk: 1800, def: 1600 });
    const paths = enumerateSmallWorldPaths([hand, bridge, target], [20, 30], [10]);
    expect(paths).toEqual([{
      handCode: 10,
      bridgeCode: 20,
      targetCode: 30,
      handBridgeShared: 'race',
      bridgeTargetShared: 'attribute',
    }]);
  });

  it('deduplicates physical copies into one code path and does not allow a one-copy bridge target', () => {
    const hand = card(10, { race: 1, attribute: 1, level: 4, atk: 0, def: 0 });
    const bridge = card(20, { race: 1, attribute: 2, level: 5, atk: 1500, def: 1200 });
    const target = card(30, { race: 2, attribute: 2, level: 6, atk: 1800, def: 1600 });
    expect(enumerateSmallWorldPaths([hand, bridge, target], [20, 20, 30, 30], [10, 10])).toHaveLength(1);
    expect(enumerateSmallWorldPaths([hand, bridge], [20, 20], [10])).toHaveLength(0);
  });

  it('scans every unique deck monster when the hand list is empty and consumes one physical copy', () => {
    const hand = card(10, { race: 1, attribute: 1, level: 4, atk: 100, def: 100 });
    const bridge = card(20, { race: 1, attribute: 2, level: 5, atk: 200, def: 200 });
    const target = card(30, { race: 2, attribute: 2, level: 6, atk: 300, def: 300 });

    expect(enumerateSmallWorldPaths([hand, bridge], [10, 20], [])).toEqual([]);
    const paths = enumerateSmallWorldPaths([hand, bridge, target], [10, 10, 20, 30], []);
    expect(paths).toHaveLength(3);
    expect(paths).toEqual(expect.arrayContaining([
      expect.objectContaining({ handCode: 10, bridgeCode: 20, targetCode: 10 }),
      expect.objectContaining({ handCode: 10, bridgeCode: 20, targetCode: 30 }),
      expect.objectContaining({ handCode: 30, bridgeCode: 20, targetCode: 10 }),
    ]));
  });

  it('silently filters non-monsters and extra-deck cards', () => {
    expect(isSmallWorldEligible(card(1))).toBe(true);
    expect(isSmallWorldEligible(card(2, { type: 0x2 }))).toBe(false);
    expect(isSmallWorldEligible(card(3, { type: 0x800021 }))).toBe(false);
  });

  it('returns unknown codes while calculating the known eligible cards', () => {
    const rows = new Map([
      [10, card(10, { race: 1, attribute: 1, level: 4, atk: 0, def: 0 })],
      [20, card(20, { race: 1, attribute: 2, level: 5, atk: 1500, def: 1200 })],
      [30, card(30, { race: 2, attribute: 2, level: 6, atk: 1800, def: 1600 })],
      [40, card(40, { type: 0x2 })],
    ]);
    const cards = { getLiteral: (code: number) => rows.get(code) ?? null } as any;
    const result = new SmallWorldService(cards).calculate([20, 30, 40, 999], [10]);
    expect(result.unknownCodes).toEqual([999]);
    expect(result.paths).toHaveLength(1);
    expect(result.summary.eligibleDeckCount).toBe(2);
    expect(result.cards.map((item) => item.code)).toEqual([20, 30, 40, 10]);
  });

  it('reports deck-wide hand mode and candidate count when hand codes are omitted', () => {
    const rows = new Map([
      [10, card(10, { race: 1, attribute: 1, level: 4, atk: 0, def: 0 })],
      [20, card(20, { race: 1, attribute: 2, level: 5, atk: 1500, def: 1200 })],
      [30, card(30, { race: 2, attribute: 2, level: 6, atk: 1800, def: 1600 })],
      [40, card(40, { type: 0x2 })],
    ]);
    const cards = { getLiteral: (code: number) => rows.get(code) ?? null } as any;
    const result = new SmallWorldService(cards).calculate([10, 20, 30, 40]);
    expect(result.summary.handMode).toBe('deck_unique');
    expect(result.summary.handCount).toBe(3);
    expect(result.summary.eligibleHandCount).toBe(3);
    expect(result.paths).toEqual(expect.arrayContaining([
      expect.objectContaining({ handCode: 10, bridgeCode: 20, targetCode: 30 }),
    ]));
  });

  it('accepts omitted and empty handCodes through the public controller', () => {
    const rows = new Map([
      [10, card(10, { race: 1, attribute: 1, level: 4, atk: 0, def: 0 })],
      [20, card(20, { race: 1, attribute: 2, level: 5, atk: 1500, def: 1200 })],
      [30, card(30, { race: 2, attribute: 2, level: 6, atk: 1800, def: 1600 })],
    ]);
    const service = new SmallWorldService({ getLiteral: (code: number) => rows.get(code) ?? null } as any);
    const controller = new SmallWorldController(service);
    expect(controller.calculate({ deckCodes: [10, 20, 30] }).summary.handMode).toBe('deck_unique');
    expect(controller.calculate({ deckCodes: [10, 20, 30], handCodes: [] }).summary.handMode).toBe('deck_unique');
  });

  it('rejects malformed public API input', () => {
    const controller = new SmallWorldController(null as any);
    const expectBadInput = (input: unknown) => {
      try {
        controller.calculate(input);
        throw new Error('expected malformed input to be rejected');
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).getResponse()).toMatchObject({
          code: 'BAD_SMALL_WORLD_INPUT',
        });
      }
    };
    expectBadInput({ deckCodes: ['20'], handCodes: [10] });
    expectBadInput({ deckCodes: [0], handCodes: [10] });
    expectBadInput({ deckCodes: [10], handCodes: ['10'] });
    expectBadInput(null);
  });
});
