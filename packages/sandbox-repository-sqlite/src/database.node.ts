import { DatabaseSync } from "node:sqlite"
import type { RepositoryDatabase, RepositoryDatabaseOptions } from "./database.ts"

export function openRepositoryDatabase(filename: string, options: RepositoryDatabaseOptions): RepositoryDatabase {
  return new DatabaseSync(filename, {
    enableForeignKeyConstraints: false,
    readOnly: options.readOnly,
  }) as unknown as RepositoryDatabase
}
