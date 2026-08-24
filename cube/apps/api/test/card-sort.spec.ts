import { sortCardCodesByPick } from '@ygocube/shared';

describe('pick-stat card ordering', () => {
  it('sorts by average percentage ascending and keeps missing cards last', () => {
    const cardMap = {
      1: { code: 1, pickStats: [{ poolId: 7, averagePickPercentage: 42 }] },
      2: { code: 2, pickStats: [{ poolId: 7, averagePickPercentage: 12 }] },
      3: { code: 3 },
    };
    expect(sortCardCodesByPick([1, 2, 3], cardMap, 7)).toEqual([2, 1, 3]);
  });

  it('preserves input order for equal statistics and duplicate physical copies', () => {
    const cardMap = {
      1: { code: 1, pickStats: [{ poolId: 7, averagePickPercentage: 20 }] },
      2: { code: 2, pickStats: [{ poolId: 7, averagePickPercentage: 20 }] },
    };
    expect(sortCardCodesByPick([2, 1, 2, 1], cardMap, 7)).toEqual([2, 1, 2, 1]);
  });

  it('does not use statistics from another pool context', () => {
    const cardMap = {
      1: { code: 1, pickStats: [{ poolId: 8, averagePickPercentage: 5 }] },
      2: { code: 2, pickStats: [{ poolId: 7, averagePickPercentage: 40 }] },
    };
    expect(sortCardCodesByPick([1, 2], cardMap, 7)).toEqual([2, 1]);
  });
});
