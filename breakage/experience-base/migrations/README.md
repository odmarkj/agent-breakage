# Experience base migrations

Plain SQL files applied in numeric order. The `npm run migrate` script (Week-1 deliverable) reads this directory, applies un-applied migrations, and optionally runs the Week-1 seed loader.

## Target database

The native Postgres 17 instance on the orch VM (`127.0.0.1:5432`), which already has pgvector installed per the project's shared-services setup. Use a dedicated role and database for the breakage framework rather than sharing `k3s_operator`:

```bash
# on the orch VM, as postgres superuser
sudo -u postgres psql -c "CREATE ROLE breakage LOGIN PASSWORD '<pw>';"
sudo -u postgres psql -c "CREATE DATABASE breakage OWNER breakage;"
sudo -u postgres psql -d breakage -c "GRANT ALL ON SCHEMA public TO breakage;"
```

Then set `DATABASE_URL=postgresql://breakage:<pw>@127.0.0.1:5432/breakage` in the runner's env.

## Applying

```bash
cd breakage
npm run migrate
```

The migrator enables `vector` in the breakage database (requires superuser OR prior `GRANT CREATE ON DATABASE breakage TO breakage`) and applies `001_pgvector_and_postmortems.sql`. Subsequent numbered files are applied in order.

## Seeding

After migrations, the seed loader walks `breakage/experience-base/seed/*.yaml`, computes an embedding for each postmortem, and upserts into `postmortems` with `source='incident-log'`. Scenario runs later append with `source='scenario'`; post-launch production incidents append with `source='production'`.

## Schema evolution

- Never edit applied migrations. Add a new numbered file.
- If the embedding dimension changes (new embedder family), add a new migration that drops and recreates the `embedding` column — this forces re-embedding of historical rows rather than silently mixing dimensions.
