// Every value is required. There are no fallbacks on purpose: a default port
// or database URL that looks real would let one worktree silently talk to
// another worktree's server or database. Unset means crash, loudly.

export type Config = {
  port: number;
  databaseUrl: string;
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Run scripts/orca-setup.sh to write .env.local, ` +
        `then use the package scripts (they pass --env-file=.env.local).`,
    );
  }
  return value;
}

export function loadConfig(): Config {
  const port = Number(required("PORT_WEB"));
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`PORT_WEB must be a positive integer, got "${process.env.PORT_WEB}"`);
  }
  return { port, databaseUrl: required("DATABASE_URL") };
}
