import { Database } from "bun:sqlite"
import type { RepositoryDatabase, RepositoryDatabaseOptions, RepositoryStatement } from "./database.ts"

export function openRepositoryDatabase(filename: string, options: RepositoryDatabaseOptions): RepositoryDatabase {
  const database = new Database(filename, options.readOnly ? { readonly: true } : { create: true })
  return {
    close: () => database.close(),
    exec: (sql) => database.exec(sql),
    prepare: (sql) => database.query(sql) as unknown as RepositoryStatement,
  }
}
