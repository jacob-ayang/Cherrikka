import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';

let sqlPromise: Promise<SqlJsStatic> | null = null;

function resolveWasmPath(): string {
  if (typeof window !== 'undefined') {
    return wasmUrl;
  }
  if (typeof process !== 'undefined' && typeof process.cwd === 'function') {
    return `${process.cwd()}/node_modules/sql.js/dist/sql-wasm.wasm`;
  }
  return wasmUrl;
}

export async function getSqlJs(): Promise<SqlJsStatic> {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({
      locateFile: (file) => {
        if (file.endsWith('.wasm')) {
          return resolveWasmPath();
        }
        return file;
      },
    });
  }
  return sqlPromise;
}

export async function openDatabase(bytes?: Uint8Array): Promise<Database> {
  const SQL = await getSqlJs();
  if (bytes && bytes.length > 0) {
    return new SQL.Database(bytes);
  }
  return new SQL.Database();
}
