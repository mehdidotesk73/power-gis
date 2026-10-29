# Cloud integration tests

The real cloud code (`src/server/cloud.ts`, through the server's requests) against a real Supabase
stack: Postgres with our schema and row-level security, Auth, the REST API and Storage. Each test
signs up fresh accounts and gives every "device" its own server and database.

Run locally (needs Docker; no Supabase account):

```sh
eval "$(scripts/test-stack.sh)"   # start the stack, apply supabase/*.sql, export the test env
npm run test:cloud
npx supabase stop --no-backup     # throw the stack away
```

CI runs the same in the `build` job. `supabase/config.toml` configures this local stack only; the
real project is untouched. Behind a registry that blocks AWS's (this sandbox), set
`SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io` first.
