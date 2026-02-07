import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';

let sqlPromise: Promise<SqlJsStatic> | null = null;

export async function getSqlJs(): Promise<SqlJsStatic> {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({
      locateFile: (file) => `/${file}`,
    });
  }
  return sqlPromise;
}

export async function openDatabase(bytes?: Uint8Array): Promise<Database> {
  const SQL = await getSqlJs();
  return bytes ? new SQL.Database(bytes) : new SQL.Database();
}

export function tableExists(db: Database, table: string): boolean {
  const stmt = db.prepare(`SELECT COUNT(1) AS c FROM sqlite_master WHERE type='table' AND name=?`);
  stmt.bind([table]);
  const exists = stmt.step() ? Number(stmt.getAsObject().c) > 0 : false;
  stmt.free();
  return exists;
}
