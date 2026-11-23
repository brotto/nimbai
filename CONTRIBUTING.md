# Contribuindo

- Node 22 + pnpm 10.
- `pnpm install` → `pnpm dev:mcp` (servidor stdio direto do TypeScript, via tsx; sem recarga automática).
- Os scripts `dev:api` e `dev:web` **não fazem nada**: `apps/api` e `apps/web` só têm README, sem `package.json`, então o filtro do pnpm não casa com projeto nenhum e o comando sai sem erro. O mesmo vale para `services/ingest` (Python 3.12, planejado).
- Commits: Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`…).
- Antes de abrir PR: `pnpm lint && pnpm typecheck && pnpm test`; `pre-commit run --all-files`.
- **Nunca** commite chaves. Use `.env` local (ignorado) e `wrangler secret put` em produção. Se vazar: revogue, rotacione, avise em SECURITY.md.
- Fontes de dados novas precisam de licença compatível com uso comercial e entrada em `ATTRIBUTIONS.md`.
