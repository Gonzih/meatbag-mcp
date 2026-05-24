# PLAN: rename meetbag → meatbag

## Task Restatement
The npm package was published as @gonzih/meetbag-mcp (typo). The repo was renamed to meatbag-mcp. We must:
1. Fix all internal "meetbag" references → "meatbag" (package.json name/bin, src/index.ts env vars + log strings + server name)
2. Build and publish @gonzih/meatbag-mcp@1.0.0
3. Deprecate the old @gonzih/meetbag-mcp@1.0.0

## Approach
Single approach — straightforward string replacement across 2 files, then build + publish.

## Files to Touch
- `package.json` — name field, bin key
- `src/index.ts` — env var names (MEETBAG_*), log prefixes, server name, comments
- `PLAN.md` / `TODO.md` — update tracking docs

## Risks & Unknowns
- npm login/token must be available in environment
- Deprecating old package requires publish rights on @gonzih/meetbag-mcp
