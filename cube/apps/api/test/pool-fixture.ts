import { parseInstancePools } from '../src/pools/instance-pools';

// Deliberately outside the generated catalog so tests control which seeds are eligible.
export const original = [900001, 900002, 900003, 900004, 900005];
export const shortlist = [900001, 900003, 900004];
export const recent = [...original, 900006, 900007, 900008];
export const firstEdition = [900001, 900002, 900003];
export const revision = [900002, 900003, 900004, 900005];
export const expansion = [...revision, 900006, 900007];
export const draftInventory = [...Array<number>(553).fill(10001), ...Array<number>(82).fill(10000)];

export function fixturePools() {
  return parseInstancePools({
    version: 1,
    draft: [{ name: 'test-paired', draftFormat: 'edison_e3', codes: draftInventory }],
    guess: [
      { key: 'builtin:test-original', name: 'Fixture original', defaultPriority: 1, codes: original },
      { key: 'builtin:test-short', name: 'Fixture short', defaultPriority: 2, codes: shortlist },
      { key: 'builtin:test-recent', name: 'Fixture recent', aliases: ['Fixture previous name'], defaultPriority: 3, codes: recent },
      { key: 'builtin:test-browse', name: 'Fixture browse', browseOnly: true, codes: expansion, previousCodes: [firstEdition, revision] },
    ],
  });
}
