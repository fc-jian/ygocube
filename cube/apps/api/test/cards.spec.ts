import { decodeCardFields, parseSetCodes } from '../src/cards/cards.service';

describe('ygopro card metadata decoding', () => {
  it('unpacks level and both pendulum scales from the cdb level field', () => {
    expect(decodeCardFields(0x1000001, (8 << 24) | (1 << 16) | 4, 1200)).toEqual({
      level: 4,
      lscale: 8,
      rscale: 1,
      linkMarkers: 0,
      defense: 1200,
    });
  });

  it('keeps Link markers for display and raw defense sorting compatibility', () => {
    expect(decodeCardFields(0x4000021, 3, 0xa3)).toEqual({
      level: 3,
      lscale: 0,
      rscale: 0,
      linkMarkers: 0xa3,
      defense: 0xa3,
    });
  });

  it('decodes all four packed set codes without signed-64-bit loss', () => {
    const packed = (0x9002n << 48n) | (0x31n << 32n) | (0x20n << 16n) | 0x1n;
    expect(parseSetCodes(packed.toString())).toEqual([0x1, 0x20, 0x31, 0x9002]);
    expect(parseSetCodes(BigInt.asIntN(64, packed).toString())).toEqual([0x1, 0x20, 0x31, 0x9002]);
  });
});
