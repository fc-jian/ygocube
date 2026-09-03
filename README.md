# YGO Cube

YGO Cube is a web control plane for Cube/draft tournaments built around
YGOPro and srvpro. It keeps tournament state on the server, exposes a player
and administrator web UI, and coordinates draft packs, deck construction, and
the match server.

## What it provides

- Passing and legacy serial draft modes, configurable pack sizes/counts,
  stratified main/extra distribution, per-player reserve time, pause/resume,
  and round reseating.
- Server-authoritative deck construction with main/extra/side limits,
  per-card copy limits, YGOPro-compatible sort, manual ordering, and deck
  shuffle simulation.
- Card-pool management from codes or `code<TAB>name` input, including literal
  card-name validation, missing-code reports, card metadata, and default-pool
  administration.
- Explicit tournament formats: round robin, manually configured Swiss rounds
  with optional single-elimination playoffs, and double elimination.
- Swiss pairings that treat previous opponents as hard exclusions, event-log
  snapshots/revert support, player authentication, SSE updates, and srvpro
  room/deck synchronization.

## Repository layout

| Path | Purpose |
| --- | --- |
| `cube/apps/api` | NestJS API, SQLite projection/event store, draft/deck/match services |
| `cube/apps/web` | Next.js player and administrator UI |
| `cube/packages/shared` | Shared TypeScript contracts |
| `srvpro` | Forked srvpro submodule with Cube room and deck integration |
| `ygopro` | Forked YGOPro submodule with Cube protocol/client support |
| `assets` | Runtime card resources provisioned separately (intentionally not tracked) |
| `dev_docs` | Architecture, protocol, and implementation notes |

The submodules are pinned to the `fc-jian` forks and the feature branches
declared in `.gitmodules` (`srvpro:cube`, `ygopro:cube-server`). Clone them
recursively:

```bash
git clone --recurse-submodules https://github.com/fc-jian/ygocube.git
cd ygocube
git submodule update --init --recursive
```

## Local development

Requirements: Node.js, pnpm, a working SQLite/native build toolchain, and the
card/srvpro resources referenced by `config.yaml`.

The root `assets/` directory is deliberately excluded from Git.  A deployment
must provision `cards.cdb`, `ygocdb_cards.json`, `script/`, `pics/`, and
`expansions/` from the matching card-data release (or point
`server.cards_cdb`/`server.card_names_json` and `pics.*` at an existing
installation).  Browser-visible names come from `ygocdb_cards.json` in the
order `sc_name`, `md_name`, `jp_name`, `cn_name`, `en_name` (blank values are
skipped), then fall back to the literal exact-code name in `cards.cdb` when no
localized value exists. The other localized fields and the CDB name are indexed
for search. YGOPro token/derivative rows are excluded from every user-facing
search and cannot be added to a pool. Card images and generated `assets/pics_avif/` thumbnails are
runtime data; cloning this repository does not create or track local symlinks.

```bash
cp config.example.yaml config.yaml
# Edit config.yaml: use unique admin tokens and set srvpro/card paths.

cd cube
pnpm install
pnpm dev
```

The web UI runs on `http://localhost:3000`; the API runs on
`http://localhost:3001`. Production builds can be checked independently:

```bash
cd cube/apps/api
npm run build
TMPDIR=/tmp npm test -- --runInBand

cd ../web
npm run build
```

The Linux YGOPro host/client build helper is at
[`scripts/build-ygopro.sh`](scripts/build-ygopro.sh). End-to-end probes live
under [`scripts/e2e`](scripts/e2e); they require the corresponding API and
srvpro services and configured test credentials.

### Updating card resources

Use the reusable pipeline in [`scripts/update-card-resources.sh`](scripts/update-card-resources.sh)
from a `codex/card-resource-sync-*` branch. `check` is read-only; `sync` fetches
the pinned `mycard/ygopro/server` commit and performs a no-ff merge with manual
conflicts; `prepare` validates SQLite/ZIP input, copies only managed Lua changes,
and generates max-200px Q30 AVIF thumbnails. Missing names for newly added
non-token cards stop a release unless `--refresh-names` or the explicitly
audited `--allow-missing-names` flag is supplied.

```bash
scripts/update-card-resources.sh check
scripts/update-card-resources.sh sync --commit
scripts/update-card-resources.sh prepare --refresh-names
scripts/update-card-resources.sh build
scripts/update-card-resources.sh test --skip-e2e   # full E2E when services are running
scripts/update-card-resources.sh deploy --confirm-maintenance
```

The image archive is cached outside the repository (override with
`YGOCUBE_CACHE_DIR`). Only `assets/pics_avif` is published to Aly; original
images never enter the release. Deployment takes a SQLite/WAL/SHM/config and
resource backup, locks the host, stops services in maintenance mode, atomically
switches the resource directories, restarts API → srvpro → Web → Nginx, and
checks API health, static JavaScript/CSS MIME responses and native `ldd` output.
On failure use `rollback --backup-id <id>`; old directories and backups are
retained until an operator verifies the release.

## Configuration and security

Do not commit `config.yaml`, administrator tokens, srvpro API keys, database
files, or production card-image directories. Use `config.example.yaml` as the
starting point and configure an exact CORS allowlist for the deployed web
origin. The API rejects placeholder super-administrator tokens and empty srvpro API keys unless
the explicitly local-only insecure-default switch is enabled.

## Licensing

Unless a file or directory says otherwise, the original YGO Cube source code
and documentation in this repository are released under the MIT License; see
[`LICENSE`](LICENSE).

The submodules are separate upstream works and are **not relicensed** by the
root license:

- `srvpro/` retains the GNU Affero General Public License, version 3, in
  [`srvpro/LICENSE`](srvpro/LICENSE).
- `ygopro/` retains the GNU General Public License, version 2, in
  [`ygopro/LICENSE`](ygopro/LICENSE).
- Nested submodules, bundled dependencies, card databases, scripts, and image
  assets retain their own copyright and license notices where applicable.

When redistributing a complete checkout or a deployment, follow all applicable
notices and source-distribution requirements for each component.
