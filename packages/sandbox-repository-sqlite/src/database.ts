export interface RepositoryStatement {
  all(...parameters: unknown[]): Record<string, unknown>[]
  get(...parameters: unknown[]): Record<string, unknown> | undefined
  run(...parameters: unknown[]): { changes: number | bigint }
}

export interface RepositoryDatabase {
  close(): void
  exec(sql: string): void
  prepare(sql: string): RepositoryStatement
}

export interface RepositoryDatabaseOptions {
  readOnly?: boolean
}
