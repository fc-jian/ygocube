# AGENTS.md - 项目约定

YGO Cube：基于 ygopro + srvpro 的轮抽模式 (Cube) 对战系统。完整设计见 `dev_docs/`（01 总览 → 08 任务拆分）。

## 项目结构

```
ygocube/
├── ygopro/     # mycard/ygopro：master=客户端；无头宿主二进制改造在 cube-server 分支（基于 origin/server）
├── srvpro/     # mycard/srvpro：CoffeeScript 服务器；改动在 cube 分支
├── assets/     # 卡牌数据 cards.cdb / pics/ / script/ / expansions/（部署进 srvpro/ygopro/）
├── cube/       # 本项目新开发 web 控制端（apps/web=Next.js, apps/api=NestJS, packages/shared=共享契约）
└── dev_docs/   # 规划与设计文档（中文），07 是接口契约，修改接口必须先改它
```

## 架构要点（必须先读）

- srvpro 每房间 spawn 一个 ygopro 无头宿主进程（`ygopro-server.coffee:1287`，参数 12 位 + cube 扩展 4 位，端口从 stdout 读），srvpro 代理玩家流量并追踪比分/卡组。
- deck size 限制在 ygopro 侧是编译期常量（`gframe/deck_manager.h:17-20`），cube 需求 = 运行时化（宿主 spawn 参数位 13~16：main_min/main_max/extra_max/side_max）。
- srvpro 房间名即规则字符串（Room 构造器解析 token：LP/TIME/START/DRAW/NOCHECK 等）；结果上报走 `room.delete()` webhook（arena_mode.post_score 先例，axios + 重试 10 次）。
- 断线重连 srvpro 已有（`settings.modules.reconnect` + UPDATE_DECK 卡组比对）。
- ygopro 协议 struct 定义在 `gframe/network.h`（带 static_assert），srvpro 侧对应 `data/proto_structs.json`，**两侧必须同步**。

## 硬性约定（Do / Don't）

- **分支纪律**：禁止直接改 ygopro/srvpro 的 master/主分支；开发一律走 `cube-server` / `cube` 特性分支。
- **统一配置**：启动前配置全部走仓库根 `config.yaml`（admin.super_token / admin.create_token / srvpro / server 路径），可用 `CONFIG_FILE` 覆盖；相对路径以 config.yaml 所在目录为基准。
- **admin token 三层**：super token 管所有 tournament + 卡池；create token 管创建（创建返回 per-tournament `admin_token`，仅管该 tournament，存哈希）；玩家仍为 `tournamentId + playerId + token` 三要素（管理员可按 tournament 关闭 token 鉴权，`POST /admin/t/:tid/security`）。
- **鉴权三要素**：cube 后端所有入口（REST/SSE/ydk）默认校验 `tournamentId + playerId + token`（cookie 或 header 或参数），缺一即 401。
- **卡图原图不落服务器**：cube 后端不存储原始 pics（不入库）；前端依次尝试本地 ygopro 根目录（`pics/`、`expansions/pics/`）→ 服务端低清 avif `GET /pics/:code.avif`（`pics.avif_dir`，默认 `assets/pics_avif/`，vips 批量生成）→ 服务端原图只读代理 `GET /pics/:code`（config.yaml `pics.ygopro_root`，可选）→ 空白卡。卡牌效果文本（desc）随卡片元数据下发。
- **所有状态在服务器**：cube 变更先写 append-only 事件日志再执行；支持快照恢复与管理员时间回溯（`POST /admin/t/:id/revert`）。
- **协议兼容**：ygopro 消息结构只增不改；宿主新增参数追加在 spawn 参数尾部；老组合必须行为不变。
- **接口契约**：三侧接口以 `dev_docs/07-protocol-api-design.md` + `cube/packages/shared` 为准，改任何一侧先更新契约。
- **选牌信息隐藏**：玩家只能看到自己当前可选牌堆的卡牌内容，其余只有数量；**SSE 广播事件一律不含卡牌/卡组内容与其他对局的房间名**（客户端 refetch 本人状态）。
- **选牌模式（draftMode）**：默认 `passing`（每玩家 FIFO 牌堆队列，**按轮发堆**：一轮全空才发下一轮；队首堆选 1 张顺时针传递；各自独立计时 + 每玩家保留时间 `reserveSeconds` 默认 300s，超时先扣 reserve 耗尽才自动选；`evenPackCount` 默认开 = 堆数须为人数整数倍）；`serial` 为旧全局串行（仅 raw config 可设）。运行时按 `packs_created` 事件是否带 `queues` 分派，旧比赛回放行为不变。
- **每玩家独立 URL**：玩家页路由为 `/t/:tid/{draft,deck,matches}/:pid`；token 按 `localStorage yc_token_<tid>_<pid>` 存储；缺失弹输入框；super token 可作万能玩家 token；tournament 关闭鉴权（`/admin/t/:tid/security`）则不校验。
- **超时自动处理**：选牌超时 = 服务器随机选（记 `auto_picked`）；构筑默认不限时，由管理员手动进入对战，显式设置构筑限时时超时 = 随机补/删至合法（记日志）。暂停/冻结必须保存并原样恢复剩余倒计时。

## 关键文件地图

| 场景 | 文件 |
|---|---|
| ygopro 宿主参数解析 | `ygopro/gframe/gframe.cpp`（server 分支 main，argc>=17 解析扩展参数） |
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

# srvpro（cube 分支）
npm install && npx coffee -c ygopro-server.coffee cube.coffee   # 编译；node ygopro-server.js 启动

# cube
pnpm install && pnpm dev                # web:3000 / api:3001

# e2e（需先启动 srvpro + cube api）
bash scripts/e2e/run-e2e.sh             # deck 限制/建房/鉴权 16 项检查
bash scripts/e2e/run-full-sim.sh        # 8 人 kuro750 BO3 完整模拟赛 → test_tournaments/<tid>/
```

## 默认端口

cube web 3000 · cube api 3001 · srvpro 游戏 7911 · srvpro http 7922 · srvpro ssl 7923 · ygopro 宿主动态（stdout 报端口）。

## 文档语言

- 规划/设计文档（dev_docs/、AGENTS.md）：中文。
- 代码：标识符/注释英文；UI 文案中英双语资源。
