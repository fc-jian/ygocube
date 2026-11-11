import { randomInt } from 'node:crypto';

export function randomSample<T>(values: readonly T[], count: number): T[] {
  const items = [...values];
  for (let index = 0; index < count; index++) {
    const other = randomInt(index, items.length);
    [items[index], items[other]] = [items[other], items[index]];
  }
  return items.slice(0, count);
}
