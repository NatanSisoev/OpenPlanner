# auth-api (sandbox)

Minimal Express app used by the **Auth System Refactor** plan in the PlanStack sandbox.

## Deprecation: legacy session middleware

**Removed.** This service no longer includes cookie-backed session middleware, an in-process session store, or `express-session` wiring. The old `src/middleware/session.ts` path was deleted as part of that cleanup.

**Do not** reintroduce cookie session stores here without a deliberate design. Follow-up work uses JWTs and refresh rotation (see the plan for `plan-auth-001`).

## Scripts

```bash
npm install
npm run build
npm start
```

`GET /api/health` returns `{ "ok": true }` (no session required).
