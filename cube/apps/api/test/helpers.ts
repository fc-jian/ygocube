import { config } from '../src/config';
import { CreateTournamentInput, TournamentsService } from '../src/tournaments/tournaments.service';
import { CardsService } from '../src/cards/cards.service';
import { PoolsService } from '../src/pools/pools.service';

// Test DB isolation: every test gets a fresh db. The temp file path is derived from
// the pid + a module counter, but jest may load this helper once per spec file (counter
// resets), so the file is physically deleted before opening — collisions cannot leak data.
export function useTestDb(): void {
  const unique = require('crypto').randomUUID();
  config.server.dbPath = `/tmp/ygocube-test-${process.pid}-${unique}.sqlite`;
  // Unit tests exercise metadata behavior with explicit fixtures. Importing a
  // deployment-sized cards.cdb for every isolated database made the suite
  // slow and environment-dependent; force the deterministic synthetic catalog.
  config.server.cardsCdb = `/tmp/ygocube-no-test-cards-${process.pid}.cdb`;
  const { closeDb, getDb } = require('../src/db');
  closeDb();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  delete require.cache[require.resolve('../src/db')];
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const events = require('../src/events/events.service');
  events.resetStateCache();
  require('fs').rmSync(config.server.dbPath, { force: true });
  require('fs').rmSync(`${config.server.dbPath}-wal`, { force: true });
  require('fs').rmSync(`${config.server.dbPath}-shm`, { force: true });
  getDb();
}

// Tournaments require a named card pool; tests share this one (whole card table).
export const TEST_POOL = 'test-pool';

export function makePools(): PoolsService {
  const cards = new CardsService();
  const pools = new PoolsService(cards);
  if (!pools.codesByName(TEST_POOL)) pools.create(TEST_POOL, cards.poolCodes());
  return pools;
}

export function makeTournaments(): TournamentsService {
  return new TournamentsService(makePools());
}

export function freshTournament(name = 'test', overrides: Partial<CreateTournamentInput> = {}): number {
  const svc = makeTournaments();
  const { tid } = svc.create({ name, maxPlayers: 4, pickSeconds: 30, cardPool: TEST_POOL, ...overrides }, 'test');
  return tid;
}
