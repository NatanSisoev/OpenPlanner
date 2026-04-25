# auth-api (sandbox)

## State

- **HTTP**: Express, JSON body, routes under `/api`.
- **Session**: None. The legacy cookie session middleware was removed; there is no `src/middleware/session.ts` and no session-related imports in `src/app.ts` or `src/api/router.ts`.
- **Database**: None in this package.

## Schema

N/A (no database).
