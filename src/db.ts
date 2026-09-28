import { SQL } from "bun";

export type Db = SQL;

export function connect(databaseUrl: string): Db {
  return new SQL(databaseUrl);
}

export async function ping(sql: Db): Promise<boolean> {
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  }
}
