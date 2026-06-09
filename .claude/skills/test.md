# /test - Run Tests

Run the GATEKeeper test suite.

## Run

```bash
npm run test                              # all tests
npm run test -- test/lambdas/status.test.ts   # one file
npm run test -- --watch                   # watch mode
```

## Key suites

- `test/lambdas/commands.test.ts` — `/gate` dispatch + Ed25519 auth.
- `test/lambdas/discord-notifications.test.ts` — the EC2-stopped notification.
- `test/utils/world-config.test.ts` — worlds.json parsing + per-guild default.
- `test/cdk/valheim-stack.test.ts` — CDK snapshot of the synthesized stack.

## Notes

- AWS is always mocked — never hit real AWS in tests.
- CDK tests are snapshot-based. When you change infra **intentionally**, regenerate:
  ```bash
  npm test -- -u
  ```
  A snapshot diff after a Lambda/script change is expected (the bundle hash moves).
- Always run tests before committing.
