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
| `assets` | Card database, scripts, and card resources used by the deployment |
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

## Configuration and security

Do not commit `config.yaml`, administrator tokens, srvpro API keys, database
files, or production card-image directories. Use `config.example.yaml` as the
starting point and configure an exact CORS allowlist for the deployed web
origin. The API rejects placeholder or duplicate administrator tokens unless
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
