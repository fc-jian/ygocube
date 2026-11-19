import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { config } from '../config';
import { closeDb } from '../db';
import { inspectMatchTables, repairMatchTables } from './match-tables';

async function main() {
  const args = process.argv.slice(2);
  const value = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const database = value('--db');
  if (!database || !fs.existsSync(database)) throw new Error('provide an existing --db path');
  config.server.dbPath = path.resolve(database);
  const planPath = value('--apply-plan');
  if (!planPath) {
    const readonly = new Database(config.server.dbPath, { readonly: true, fileMustExist: true });
    try { console.log(JSON.stringify(inspectMatchTables(readonly), null, 2)); } finally { readonly.close(); }
    return;
  }
  if (!args.includes('--offline')) throw new Error('--offline confirms the API and all database writers are stopped');
  const backup = value('--backup');
  if (!backup || fs.existsSync(backup)) throw new Error('provide a new --backup file path');
  await repairMatchTables(JSON.parse(fs.readFileSync(planPath, 'utf8')), path.resolve(backup));
  console.log(JSON.stringify({ ok: true, remaining: inspectMatchTables().conflicts.length }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(closeDb);
