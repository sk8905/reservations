// Loads the Bouchon Racine research fixture into the LOCAL dev KV store so
// the app can be tried without an Anthropic key. Usage: npm run seed:local
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { normaliseProfile, searchedUrls, extractJson, finalText } from '../src/profile.js';

const research = JSON.parse(readFileSync(new URL('../tests/fixtures/research-response.json', import.meta.url), 'utf8'));
const p = normaliseProfile(extractJson(finalText(research.content)), searchedUrls(research.content),
  { name: 'Bouchon Racine', city: 'London', now: Date.parse('2026-11-05T10:00:00Z') });
mkdirSync('.wrangler/seed', { recursive: true });
writeFileSync('.wrangler/seed/profile.json', JSON.stringify(p));
writeFileSync('.wrangler/seed/index.json', JSON.stringify([{ id: p.id, name: p.name, area: p.area, checkedAt: p.checkedAt }]));
const put = (key, file) => execFileSync('npx', ['wrangler', 'kv', 'key', 'put', '--local', '--binding', 'PLANNER', key, '--path', file], { stdio: 'inherit' });
put(`r:${p.id}`, '.wrangler/seed/profile.json');
put('r:index', '.wrangler/seed/index.json');
console.log(`Seeded ${p.name} (${p.id})`);
