/**
 * Fixture capture bridge — the missing tool the roadmap flagged.
 *
 * Booking serves an Akamai challenge to curl, so property pages are captured
 * from a REAL browser: this server receives the rendered DOM via POST and
 * writes it under the chosen fixture directory. (Airbnb and most hotel chains
 * serve full HTML server-side, so plain `curl -L -A "<browser UA>"` works for
 * those — see fixtures/live-airbnb/manifest.json.)
 *
 * Workflow:
 *   1. node scripts/capture-server.mjs            # or OUT_DIR=fixtures/live-airbnb node …
 *   2. Open the listing in any real browser, let it hydrate.
 *   3. In DevTools console:
 *        await fetch('http://127.0.0.1:8787/?name=<cc>-<slug>.<locale>.html',
 *          { method:'POST', body:'<!DOCTYPE html>\n'+document.documentElement.outerHTML })
 *      (On sites whose CSP blocks localhost fetches — Airbnb does — use curl.)
 *   4. npm run scrub               # MANDATORY before committing: third-party
 *                                  # API keys and session tokens must not ship.
 *   5. Add the source URL to the directory's manifest.json.
 *   6. npm run generate            # derived corpora iterate every live fixture.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.resolve(ROOT, process.env.OUT_DIR ?? 'fixtures/live');
fs.mkdirSync(OUT_DIR, { recursive: true });

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  if (req.method !== 'POST') { res.writeHead(405).end(); return; }

  const url = new URL(req.url, 'http://localhost');
  const name = (url.searchParams.get('name') ?? '').replace(/[^a-z0-9._-]/gi, '');
  if (!name || !name.endsWith('.html')) { res.writeHead(400).end('bad name'); return; }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    fs.writeFileSync(path.join(OUT_DIR, name), body);
    console.log(`saved ${name} ${body.length} bytes -> ${OUT_DIR}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, name, bytes: body.length }));
  });
});

server.listen(8787, '127.0.0.1', () => console.log(`capture server on 127.0.0.1:8787 -> ${OUT_DIR}`));
