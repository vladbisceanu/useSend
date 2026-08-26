# useSend production fork

This repository is GrowthPath Mail's production fork of
[`usesend/useSend`](https://github.com/usesend/useSend). It owns the running
service at `send.growthpath.systems`, including the application, Railway,
SES/SNS, sending-domain DNS, Postgres, Redis, backups, health, upgrades, and
the cross-product migration program.

Consumer repositories own their integrations, templates, runtime variables,
deployments, and acceptance proof. `setup-works` owns Builder OS, fleet
configuration, and shared credential plumbing only.

## Branches and delivery

- `main` mirrors upstream. Keep GrowthPath-only commits out of it.
- `growthpath-mail` is the production base. Railway deploys pushes to this
  branch, so work on a feature branch and merge through a PR.
- Start service work from current `growthpath-mail`. Start an upstream
  contribution from the appropriate upstream commit, then reconcile the
  accepted or carried patch into `growthpath-mail` deliberately.
- Treat an upstream update as a versioned change. Compare the full diff,
  identify duplicate local patches, review Prisma migrations, back up
  Postgres, run the relevant suites, then deploy and prove the exact merge SHA
  plus `/api/health`.
- Keep the running AGPL source link pointed at the complete corresponding
  public source.

## Work tracking

GitHub issues in this repository are the useSend service queue. The active
parent epic owns the multi-brand rollout; consumer migration tickets remain
native sub-issues in their product repositories.

Every issue has exactly one `type/*`, at least one `area/*`, and exactly one
`priority/*` label.

| Label | Covers |
|---|---|
| `area/web` | `apps/web/`: dashboard, API, delivery, campaigns, contacts |
| `area/smtp` | `apps/smtp-server/`: SMTP proxy and delivery path |
| `area/marketing` | `apps/marketing/`: public useSend site |
| `area/packages` | `packages/`: SDKs, editor, UI, shared configuration |
| `area/infra` | `docker/`, `.github/`, Railway, AWS, DNS, Postgres, Redis, operations |
| `area/docs` | `AGENTS.md`, README files, `apps/docs/`, contributor guidance |

Use `type/bug`, `type/feature`, `type/task`, or `type/debt`, and
`priority/p0`, `priority/p1`, or `priority/p2`. Label every area a change
touches.

## Provider and data safety

- Use the provider-native CLI or API for Railway, AWS, and Cloudflare work.
- Read the global `secrets-management` skill before handling credentials or
  environment variables. Production secrets stay in their provider store.
- Treat shared and production databases as protected. Run a migration there
  only when the issue authorizes it and the backup and recovery path are
  verified.
- Startup runs Prisma migrations. A production version upgrade therefore
  requires a fresh database backup before merge or redeploy.
- Preserve authenticated SNS callbacks, bounded external requests,
  hard-bounce and complaint suppression, idempotency, and RFC 8058
  unsubscribe behavior.

## Repository map

- `apps/web/`: Next.js application, Prisma, tRPC, Tailwind, public API.
- `apps/marketing/`: public marketing site.
- `apps/docs/`: Mintlify documentation.
- `apps/smtp-server/`: TypeScript SMTP proxy.
- `packages/`: SDKs, email editor, UI, and shared configuration.
- `docker/`: self-hosted build and runtime.

Use top-level imports rather than dynamic imports. Prefer tRPC for internal
application APIs unless the contract must be public or provider-facing.

## Verification

Install with `pnpm install --frozen-lockfile`. Start with the focused check,
then widen in proportion to the change:

```bash
pnpm --filter=web typecheck
pnpm test:web:unit
pnpm test:web:trpc
pnpm test:web:api
pnpm lint
pnpm build:web
```

`pnpm test:web:all` and `pnpm test:web:integration:full` start local Postgres
and Redis and apply Prisma migrations. Run them when the issue's verification
requires the full integration path, using disposable local data only.

Use Conventional Commit and PR titles. Before filing, inspect the staged diff,
run review against `growthpath-mail`, and record the checks and any migration
or deployment effect in the PR.
