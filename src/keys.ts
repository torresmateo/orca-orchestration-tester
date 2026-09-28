import type { Db } from "./db";

// API keys (DESIGN C4). A key is shown to the operator once, at creation.
// Only its SHA-256 hex is stored, and lookups compare hashes: the raw key
// never reaches the database or a log line.

export type ApiKey = { id: string; name: string };

export function hashKey(key: string): string {
  return new Bun.CryptoHasher("sha256").update(key).digest("hex");
}

function generateKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `snip_${Buffer.from(bytes).toString("base64url")}`;
}

// Inserts a new key and returns the raw value. The caller must show it now;
// it cannot be recovered later.
export async function createKey(sql: Db, name: string): Promise<{ id: string; key: string }> {
  const key = generateKey();
  const [row] = await sql`
    insert into api_keys (name, key_hash) values (${name}, ${hashKey(key)})
    returning id`;
  return { id: String(row.id), key };
}

// Resolves `Authorization: Bearer <key>` to an active key, or null for a
// missing header, another scheme, an empty token, an unknown key or a
// revoked one. Callers treat every null the same way (DESIGN D5).
export async function authenticate(sql: Db, req: Request): Promise<ApiKey | null> {
  const match = /^Bearer (\S+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!match) return null;
  const [row] = await sql`
    select id, name from api_keys
    where key_hash = ${hashKey(match[1]!)} and revoked_at is null`;
  return row ? { id: String(row.id), name: row.name } : null;
}
