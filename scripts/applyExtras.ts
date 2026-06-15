import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from 'pg';
import { config } from '../src/config.js';

/** Applies prisma/post_migrate.sql (tsvector column + ANN/GIN indexes). */
async function main() {
  // Resolve from CWD (project root in dev, /app in Docker) — the .sql file is
  // not compiled into dist, so a file-relative path breaks once built.
  const sql = await readFile(join(process.cwd(), 'prisma', 'post_migrate.sql'), 'utf8');
  const client = new Client({ connectionString: config.DATABASE_URL });
  await client.connect();
  try {
    await client.query(sql);
    // eslint-disable-next-line no-console
    console.log('post_migrate.sql applied');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
