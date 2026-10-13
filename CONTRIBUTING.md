# Contribuindo

- Node 22 + pnpm 10; Python 3.12 para `services/ingest`.
- `pnpm install` → `pnpm dev:mcp` (stdio) ou `pnpm dev:api` (Workers via wrangler).
- Commits: Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`…).
- Antes de abrir PR: `pnpm lint && pnpm typecheck && pnpm test`; `pre-commit run --all-files`.
- **Nunca** commite chaves. Use `.env` local (ignorado) e `wrangler secret put` em produção. Se vazar: revogue, rotacione, avise em SECURITY.md.
- Fontes de dados novas precisam de licença compatível com uso comercial e entrada em `ATTRIBUTIONS.md`.
