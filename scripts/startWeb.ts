import { execFileSync } from 'node:child_process';

/**
 * Production web entrypoint for hosts that can't run a separate pre-deploy step
 * (e.g. Render free tier). Runs migrations → search indexes → seed, then starts
 * the API — all from Node, so there's no shell/quoting/PATH fragility in the
 * platform's "docker command" (status 127 territory). All steps are idempotent.
 *
 * Used as: `node dist/scripts/startWeb.js`
 */
function run(label: string, args: string[]): void {
  // eslint-disable-next-line no-console
  console.log(`[start-web] ${label}`);
  execFileSync(process.execPath, args, { stdio: 'inherit' });
}

run('prisma migrate deploy', ['node_modules/prisma/build/index.js', 'migrate', 'deploy']);
run('apply search indexes (post_migrate.sql)', ['dist/scripts/applyExtras.js']);
run('seed demo data', ['dist/prisma/seed.js']);

// Importing the server module auto-starts it (listens on $PORT).
// eslint-disable-next-line no-console
console.log('[start-web] starting API');
await import('../src/api/server.js');
