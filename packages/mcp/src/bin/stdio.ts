#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { VERSION, createServer } from '../server.js';

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

/**
 * One instance is pinned per connection by serveStdio, which also decides the
 * protocol era from the opening exchange — so the same factory serves both the
 * 2026 spec and the 2025-era clients (claude.ai, ChatGPT) unchanged.
 * Diagnostics go to stderr: stdout is the JSON-RPC wire.
 */
serveStdio(() => createServer(), {
  onerror: (error) => process.stderr.write(`[nimbai] ${error.message}\n`),
});
