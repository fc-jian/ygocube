# AGENTS.md - 项目约定

YGO Cube：基于 ygopro + srvpro 的轮抽模式 (Cube) 对战系统。完整设计见 `dev_docs/`（01 总览 → 08 任务拆分）。

## 项目结构

```
ygocube/
├── ygopro/     # fc-jian/ygopro：cube-server 分支同时承载客户端与无头宿主改造
├── srvpro/     # fc-jian/srvpro：CoffeeScript 服务器；改动在 cube 分支
├── assets/     # 运行时卡牌资源挂载点（不入 Git，cards.cdb/ygocdb_cards.json/pics/script/expansions 需单独提供）
├── cube/       # 本项目新开发 web 控制端（apps/web=Next.js, apps/api=NestJS, packages/shared=共享契约）
└── dev_docs/   # 规划与设计文档（中文），07 是接口契约，修改接口必须先改它
```

## 架构要点（必须先读）

- srvpro 每房间 spawn 一个 ygopro 无头宿主进程（传统参数 12 位；Cube 追加 `--cube-deck-limits` + 4 个限制，端口从 stdout 读），srvpro 代理玩家流量并追踪比分/卡组。
- deck size 上限由 ygopro 宿主运行时化；新协议参数位 13 为 marker、14~17 为 `main_min/main_max/extra_max/side_max`，旧 13~16 纯数字布局仍兼容。
- srvpro 房间名即规则字符串（Room 构造器解析 token：LP/TIME/START/DRAW/NOCHECK 等）；结果上报走 `room.delete()` webhook（arena_mode.post_score 先例，axios + 重试 10 次）。
- 断线重连 srvpro 已有（`settings.modules.reconnect` + UPDATE_DECK 卡组比对）。
- ygopro 协议 struct 定义在 `gframe/network.h`（带 static_assert），srvpro 侧对应 `data/proto_structs.json`，**两侧必须同步**。

## 硬性约定（Do / Don't）

- **分支纪律**：禁止直接改 ygopro/srvpro 的 master/主分支；开发一律走 `cube-server` / `cube` 特性分支。
- **统一配置**：启动前配置全部走仓库根 `config.yaml`（admin.super_token / srvpro / server 路径），可用 `CONFIG_FILE` 覆盖；相对路径以 config.yaml 所在目录为基准。create token 不再写入配置文件。
- **admin token 三层**：super token 管所有 tournament + 卡池；super admin 通过 `/admin/create-users` 管理数据库创建权限用户，创建者用 `X-Create-User` + `X-Create-Token` 创建并管理自己创建的比赛（比赛记录 `created_by`）；比赛专有 `admin_token` 已取消，旧值立即失效；玩家仍为 `tournamentId + playerId + token` 三要素（管理员可按 tournament 关闭 token 鉴权，`POST /admin/t/:tid/security`）。创建用户删除或轮换后，其既有比赛管理权限立即失效。
- **鉴权三要素**：cube 后端所有入口（REST/SSE/ydk）默认校验 `tournamentId + playerId + token`（cookie 或 header 或参数），缺一即 401。
- **卡图原图不落服务器**：cube 后端不存储原始 pics（不入库）；前端依次尝试本地 ygopro 根目录（`pics/`、`expansions/pics/`）→ 服务端低清 avif `GET /pics/:code.avif`（`pics.avif_dir`，默认 `assets/pics_avif/`，vips 批量生成）→ 服务端原图只读代理 `GET /pics/:code`（config.yaml `pics.ygopro_root`，可选）→ 空白卡。卡牌效果文本（desc）随卡片元数据下发。
- **卡名来源**：API 的结构化卡片数据仍来自 `cards.cdb`，但前端可见名称由 `server.card_names_json`（默认 `assets/ygocdb_cards.json`）按 exact code 提供，显示优先级为 `sc_name` → `md_name` → `jp_name` → `cn_name` → `en_name`；`nwbbs_n`、`cnocg_n`、`jp_ruby` 等字段仅加入搜索索引，不替代显示名。映射缺失或上述字段均为空时，最终回退到同一 exact code 在 CDB `texts.name` 中的原名，避免非衍生物出现空白名称。YGOPro `TYPE_TOKEN` 衍生物不出现在任何用户搜索结果，也不能加入卡池或候选池。
- **候选池**：每个 `card_pools` 记录都绑定一个默认为空的 `candidate_codes_json`。`/pool/:name/candidate` 公开只读浏览；新增候选卡需要任意有效比赛玩家的 `X-Tournament-Id` + `X-Player-Id` + `X-Token`，只允许追加、不能删除。候选池只用于提案预览，不进入比赛牌堆；主卡池保存时以事务方式移除已晋升的候选 code。
- **所有状态在服务器**：cube 变更先写 append-only 事件日志再执行；支持快照恢复与管理员时间回溯（`POST /admin/t/:id/revert`）。
- **协议兼容**：ygopro 消息结构只增不改；宿主新增参数追加在 spawn 参数尾部；老组合必须行为不变。
- **接口契约**：三侧接口以 `dev_docs/07-protocol-api-design.md` + `cube/packages/shared` 为准，改任何一侧先更新契约。
- **选牌信息隐藏**：玩家只能看到自己当前可选牌堆的卡牌内容，其余只有数量；**SSE 广播事件一律不含卡牌/卡组内容与其他对局的房间名**（客户端 refetch 本人状态）。
- **选牌模式（draftMode）**：默认 `passing`（每玩家 FIFO 牌堆队列，**按轮发堆**：一轮全空才发下一轮；队首堆选 1 张顺时针传递；各自独立计时 + 每玩家保留时间 `reserveSeconds` 默认 400s，超时先扣 reserve 耗尽才自动选；`evenPackCount` 默认开 = 堆数须为人数整数倍）；`serial` 为旧全局串行（仅 raw config 可设）。运行时按 `packs_created` 事件是否带 `queues` 分派，旧比赛回放行为不变。
- **开始选牌确认**：后台 `start_draft` 先创建持久化的 60 秒全员确认窗口，不生成牌堆；每名当前报名玩家必须通过自己的玩家身份确认，最后一人确认时才在同一事务中生成牌堆并进入 `drafting`。超时自动取消且保持报名阶段；确认窗口期间禁止增删/退出玩家，服务重启后按截止时间恢复定时器。玩家准备页在确认窗口或已点击准备后每 5 秒轮询，后台同步展示未确认名单。
- **每玩家独立 URL**：玩家页路由为 `/t/:tid/{draft,deck,matches}/:pid`；token 按 `localStorage yc_token_<tid>_<pid>` 存储；缺失弹输入框；super token 可作万能玩家 token；tournament 关闭鉴权（`/admin/t/:tid/security`）则不校验。
- **超时自动处理**：选牌超时 = 服务器随机选（记 `auto_picked`）；构筑默认不限时，由管理员手动进入对战，显式设置构筑限时时超时 = 随机补/删至合法（记日志）。暂停投票已取消，只允许超级管理员或比赛创建者从后台暂停/恢复；暂停不会自动恢复，暂停/冻结必须保存并原样恢复剩余倒计时。

## 关键文件地图

| 场景 | 文件 |
|---|---|
| ygopro 宿主参数解析 | `ygopro/gframe/gframe.cpp`、`server_args.h`（marker/legacy 限制参数与 seed） |
| ygopro deck 校验 | `ygopro/gframe/deck_manager.cpp` CheckDeck/LoadDeck；常量在 deck_manager.h |
| ygopro 协议 | `ygopro/gframe/network.h`（含 cube 自定义 STOC_CUBE_DECK=0xA，卡组推送） |
| ygopro 客户端卡组锁定 | `ygopro/gframe/duelclient.cpp`（STOC_CUBE_DECK case）、`menu_handler.cpp`/`deck_con.cpp`（锁定与 siding 自检） |
| srvpro 房间/规则解析 | `srvpro/ygopro-server.coffee` class Room (1289)，规则段 1333-1436，spawn 1454 |
| srvpro 卡组处理 | `ygopro-server.coffee` UPDATE_DECK handler（cube 覆盖按 duel_stage 分流：BEGIN 整包覆盖 / siding 校验后原样转发），STOC_CUBE_DECK 注入在 stoc_follow JOIN_GAME，room.delete 上报 (1510) |
| srvpro 配置 | `srvpro/data/default_config.json` → `config/settings.json`；模块开关 `settings.modules.*` |
| cube 后端 | `cube/apps/api/src/`（auth/tournaments/draft/decks/matches/events/realtime/admin） |
| cube 前端 | `cube/apps/web/`（draft/deck/matches 三页 + CardImage 本地卡图） |
| SQLite schema | `dev_docs/05-cube-backend-plan.md` §8 |

## 常用命令

```bash
# ygopro（cube-server 分支，Linux）
bash scripts/build-ygopro.sh            # 无头宿主：产物 ygopro/bin/release/ygopro → 放 srvpro/ygopro/
bash scripts/build-ygopro.sh --client --no-audio --build-freetype --build-png --build-jpeg --max-extra=30 --max-side=30
                                        # GUI 客户端：产物 ygopro/bin/release/YGOPro（GUI 依赖源码需按 .github/workflows/build.yml 下载到 ygopro/{irrlicht,freetype,png,jpeg}）
bash scripts/build-ygopro.sh --client --build-freetype --build-png --build-jpeg --build-opus-vorbis
                                        # Linux 有声 GUI：另需上游指定版本的 miniaudio/Ogg/Opus/Opusfile/Vorbis 源码

# srvpro（cube 分支）
npm install && npx coffee -c ygopro-server.coffee cube.coffee   # 编译；node ygopro-server.js 启动

# cube
pnpm install && pnpm dev                # web:3000 / api:3001

# e2e（需先启动 srvpro + cube api）
bash scripts/e2e/run-e2e.sh             # deck 限制/建房/鉴权 16 项检查
bash scripts/e2e/run-full-sim.sh        # 8 人 kuro750 BO3 完整模拟赛 → test_tournaments/<tid>/

# 上游卡片资源同步（必须在 codex/card-resource-sync-* 分支）
bash scripts/update-card-resources.sh check
bash scripts/update-card-resources.sh sync --commit
bash scripts/update-card-resources.sh prepare --refresh-names
bash scripts/update-card-resources.sh build
bash scripts/update-card-resources.sh test
bash scripts/update-card-resources.sh deploy --confirm-maintenance
```

## Aly 发布与 Web 静态资源验收

- Next.js 使用 `output: standalone` 时，`.next/standalone` 只包含服务端运行时，**不会自动包含** `.next/static`（以及可能使用的 `public`）。发布 Web 时必须把 `cube/apps/web/.next/static` 同步到 release 的 `web/standalone/apps/web/.next/static`，并按需同步 `public`；不能只打包 standalone 目录。
- Web release 应先在临时目录解包并校验 build ID、文件数量和校验和，再在同一文件系统内原子切换 `current`。静态目录安装完成后重启 `ygocube-web`，使 Next 重新加载静态文件映射；API、srvpro 不应因 Web 静态资源修复而重启。
- 健康检查不能只验证首页 200。发布前后至少检查：`/api/health`、首页 HTML 中引用的每个 `/_next/static/*.js`/`*.css` 均返回 200 且 MIME 正确、HTTPS/Nginx 路径，以及四个 systemd 服务状态。缺少静态文件时 Next 仍可能返回首页 HTML 200，但浏览器会收到 404 HTML 并报 `strict MIME type checking`。
- 失败发布先保留旧 release 和数据库备份；不要通过把所有请求回退到首页来掩盖静态资源 404。完成验证后再清理上传临时文件，并记录 release commit/build ID。

## 默认端口

cube web 3000 · cube api 3001 · srvpro 游戏 7911 · srvpro http 7922 · srvpro ssl 7923 · ygopro 宿主动态（stdout 报端口）。

## 文档语言

- 规划/设计文档（dev_docs/、AGENTS.md）：中文。
- 代码：标识符/注释英文；UI 文案中英双语资源。
