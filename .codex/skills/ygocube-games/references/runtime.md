# 运行与发布

## 本地

Windows 工作区为 `C:/projects/ygocube`。Node.js 22，pnpm 版本以 `cube/package.json` 的 `packageManager` 为准。使用根 `config.yaml` 或通过 `CONFIG_FILE` 指定配置，所有相对配置路径以配置文件所在目录解析。示例中的卡库与字段表为 `srvpro/ygopro/cards.cdb`、`srvpro/ygopro/strings.conf`，名称与缩略图为 `assets/ygocdb_cards.json`、`assets/pics_avif/`。应用库由 `server.db_path` 指定，示例为 `data/cube.sqlite`，本机迁移快照为 `data/cube.windows.sqlite`。[示例配置](../../../../config.example.yaml) · [Windows 开发文档](../../../../dev_docs/10-windows-development.md)

| 本地入口 | Web / API | 运行目录与说明 |
| --- | --- | --- |
| Windows Cube，`scripts/dev-windows.ps1` | 3200 / 3201 | 日志与生成配置在 `data/local-dev/cube/`，Next 输出为 `.next-cube`，小游戏打开 `http://127.0.0.1:3200/games/guess`。 |
| Windows 独立 Duel，`scripts/dev-windows.ps1 -Duel` | 3100 / 3101 | 日志与生成配置在 `data/local-dev/duel/`，库为其中的 `duel.sqlite`，Next 输出为 `.next-duel`。 |
| Linux Cube，`node scripts/dev-local.cjs` 或 `pnpm --dir cube dev` | 3000 / 3001 | 前者生成独立运行目录，后者启动 Web/API 开发进程。 |

Windows 可用启动器的 `-Action Status` 和 `-Action Stop` 管理本项目进程。小游戏可以用临时 SQLite、实际卡库和独立回环端口测试 Web/API，无需为 Guess 起 ygopro 对局宿主。配置、数据库、`assets/`、本地日志和构建产物留在运行目录。自动化测试用临时库，避免污染常用本地卡池。[启动器](../../../../scripts/dev-windows.ps1) · [本地运行配置](../../../../scripts/dev-local.cjs)

- Windows 先运行 `. .\scripts\activate-windows.ps1` 激活环境。仓库根执行 `pnpm --dir cube test` 和 `pnpm --dir cube build`。API 用 Jest，Web 用 Node test runner。Guess 的房间及提示已有测试夹具。修改页面后用浏览器核对游戏主流程与布局。[Guess API 测试](../../../../cube/apps/api/test/guess.spec.ts) · [提示测试](../../../../cube/apps/api/test/guess-opening-hints.spec.ts) · [Web 测试](../../../../cube/apps/web/test)
- Windows / Linux 分别安装和构建。Linux 可用 WSL 的隔离工作副本做回归与 release 构建。Aly 使用 Linux standalone，连同 `.next/static` 和存在时的 `public` 归档。仓库 Web 的 postbuild 已复制资源，打包时仍需校验产物。[Next 配置](../../../../cube/apps/web/next.config.mjs) · [静态资源准备](../../../../cube/apps/web/scripts/prepare-standalone.mjs)

## Aly 路由和路径

用既有 SSH 别名 `aly`。公网基址为 `https://39.96.220.91`。先按系统服务与实际 `CONFIG_FILE` 核对活动配置和 `current` 的目标，路径表用于定位。避免打印配置全文、凭据或私钥。

| 项目 | Cube 实例 | 独立 Duel 实例 |
| --- | --- | --- |
| 安装根与 release | `/opt/ygocube` 下的 `current`、`releases/<id>` | `/opt/ygoduel` 下的 `current`、`releases/<id>` |
| 业务 SQLite | `/opt/ygocube/shared/data/cube.sqlite` | `/opt/ygoduel/shared/data/duel.sqlite` |
| 配置查找 | `current/config.yaml` 或 `shared/config.yaml`，以服务为准 | `/opt/ygoduel/shared/config.yaml` |
| 受管资源 | `/opt/ygocube/shared/srvpro/ygopro/` 的卡库和扩展，`shared/assets/` 的名称与 AVIF | `/opt/ygoduel/current/srvpro/ygopro/`、`current/assets/`，按资源流程与 Cube shared 保持同代 |
| 内网 Web / API | 3000 / 3001 | 3100 / 3101 |
| srvpro 游戏 TCP / 私有 HTTP | 7911 / 7922 | 17911 / 17922 |
| 公网 | `/games/guess`、`/api/games/guess/…`，静态资源 `/_next/static/…` | `/duel/decks` 等 Duel 页面、`/duel-api/…`，静态资源 `/duel-assets/_next/static/…` |
| systemd | `ygocube-web`、`ygocube-api`、`ygocube-srvpro` | `ygoduel-web`、`ygoduel-api`、`ygoduel-srvpro` |

两个实例共用 Nginx。Cube API 内部控制器路径是 `/games/guess/…`，浏览器通过 `/api` 前缀访问。独立 Duel 构建用 `NEXT_PUBLIC_API_BASE=/duel-api`、`NEXT_ASSET_PREFIX=/duel-assets` 和对应的 API 上游。两套卡图分别走 `/api/pics/:code.avif`、`/duel-api/pics/:code.avif`。公网健康分别核对 `/api/health`、`/duel-api/public/duel/options`，再核对实际页面。[部署隔离契约](../../../../dev_docs/07-protocol-api-design.md) · [Aly 发布记录](../../../../dev_docs/20-aly-release-20261023.md)

## 已授权的应用发布

1. 确认影响面和对局状态。Guess 专属变更用 Cube 目标。共享检索影响 `/duel/decks` 时验证并发布两套 API/Web。发布前检查原生对局与受影响小游戏。常规 Guess API/Web 发布用 `--require-idle-guess` 在 `playing` 或 `between_rounds` 时推迟切换。只有本次明确授权批量结算才选对应的 `--settle-*`。`--settle-started-guess` 保留等候房，`--settle-open-guess` 也会结算等候房。新增游戏时，把会受维护影响的房间纳入空闲检查。[应用发布入口](../../../../scripts/deploy-card-details.py)
2. 从明确的源码提交生成 Linux 应用产物。应用包里的 Cube Web 放在 `payload/ygocube/web/standalone/apps/web`，独立 Duel Web 放在 `payload/ygoduel/web/apps/web`。两处各有 `.next/BUILD_ID` 和 `.next/static`。复用 `package-app-release.py` 与 `deploy-card-details.py`，先 stage 核验包哈希、文件清单、静态资源与 build ID，再激活。按目标及组件选择 `--cube-only`、`--api-web-only`、`--web-only`。激活时各实例在 `backups/<id>/` 保存配置、原 release 指针和经过完整性及外键检查的 SQLite 备份。原子切换 `current`，只重启本次涉及的服务。卡片资源变更另走 `update` 技能。[打包器](../../../../scripts/package-app-release.py) · [发布约定](../../update/SKILL.md)
3. 核验 HTTPS、服务状态、健康接口、变更页面及其引用的每个 JS/CSS 的 HTTP 状态和 MIME。用 `--check-page` 将小游戏页面加入公网资源验收。按用户授权用独立测试房验证核心流程，结算后检查统计。验证通过后清理本次上传暂存，记录源码提交、release、build ID 和备份路径。失败保留上一版、备份和日志，由发布流程按对局状态决定能否安全回滚。[Guess 发布验收实例](../../../../dev_docs/21-guess-default-pool-20261107.md)
