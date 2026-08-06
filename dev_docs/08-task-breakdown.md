# 08 - 任务拆分与里程碑

> 依赖关系：M0 → M1/M2（并行）→ M3（部分并行 M4）→ M5 → M6 → M7。每项任务给出验收标准（DoD）。

## 实施进度（2026-08-05 v4：卡图/效果文本/超时入组/中文 UI）

| 里程碑 | 状态 | 说明 |
|---|---|---|
| M0 环境与分支 | ✅ | environment.yml + envs/ygocube；scripts/fetch-tools.sh（premake5 源码构建）、build-ygopro.sh；ygopro `cube-server`、srvpro `cube` 分支 |
| M1 ygopro 宿主 | ✅ | 参数位 13~16 deck limits + 旧组合兼容判别；CheckDeck/LoadDeck 运行时化；`no_check_deck=T` 仍强制校验；Linux 产物 bin/release/ygopro 已编译 |
| M2 srvpro | ✅ | MAIN/EXTRA/SIDE token、spawn 参数、cube.coffee（create_room/room_status/close_room + api_key）、UPDATE_DECK 固定卡组覆盖（返回替换 buffer）、结果 webhook；**scripts/e2e/run-e2e.sh 9/9 通过** |
| M3 cube 后端核心 | ✅(2026-08-06 复审) | 新增：重复报名拦截、卡组子集校验、maxCopies 可配置、pick target_zone、暂停到期自动恢复 | 统一 config.yaml；三层 admin token + super 万能玩家 token；按 tournament 关闭 token 鉴权；卡池维护 + 公开下拉列表；SSE 脱敏；卡牌搜索；**效果文本 desc 导入**；**选牌（含超时自动选）即时写入卡组**（左侧立即可见）；**卡图只读代理 GET /pics/:code**（不入库）；**jest 28/28 通过** |
| M4 对局编排 | ✅(2026-08-06 复审) | 修复 9+ 人瑞士轮→季后赛转换（按积分种子）；17+ 轮数改 ceil(log2N)+1；tiebreaker 加净胜局；建房失败轮询重试（30s 冷却）；webhook 加 api_key 鉴权 | 排表（单循环/瑞士轮/淘汰赛）、SrvproClient + mock、webhook 接收 + 轮询兜底、房间创建（含 deck limits 与固定卡组下发）——全部有测试覆盖；对局阶段回溯联动（M4.4）未实测 |
| M5 前端选牌/构筑 | ✅ | 每玩家独立 URL `/t/:tid/{draft,deck,matches}/:pid`；token 输入框/super 万能；**全中文 UI + 排版优化**；**卡图三通道加载（本地→服务端代理→空白卡）**；**hover 放大卡图+效果文本**；选牌页搜索过滤；构筑页搜索面板（仅未使用卡可加 side）；logout；`next build` 干净 |
| M6 对局/管理页 | ✅(2026-08-06 复审) | 补管理台回溯按钮、编辑参数 maxCopies、榜单净胜列 | matches 页（独立 URL/对阵/房间名/复制）、admin 页（阶段控制/暂停/security 开关/卡池管理/回溯）已实现；房间密码下发到玩家（M6.2 细化）未完成 |
| M7 端到端 | ⏳ | 真机 4 人完整比赛、故障演练、Docker 部署、安全审查未做 |

历史数据已清空（2026-08-04），当前为全新数据库。

## M0 环境与分支准备（基础设施）

| # | 任务 | 涉及 | DoD |
|---|---|---|---|
| 0.1 | ygopro 建立 `cube-server` 分支（基于 origin/server）；diff master 评估漂移 | ygopro/ | 分支存在；README 记录基于的 commit |
| 0.2 | srvpro 建立 `cube` 分支（基于 master） | srvpro/ | 分支存在 |
| 0.3 | Linux 编译 ygopro server 分支产物；Windows 编译（或 CI 产出） | ygopro/ | `./ygopro` 可无头启动并打印端口 |
| 0.4 | 本地部署 srvpro（npm install + coffee 编译 + config）+ ygopro 产物 + assets（cards.cdb/script/pics/expansions）进 `srvpro/ygopro/` | srvpro/ | 两个 ygopro 客户端可经 srvpro 正常对战 |
| 0.5 | cube 脚手架：Next.js + NestJS monorepo（pnpm workspace）+ shared 包 + ESLint/Prettier + CI 骨架 | cube/ | `pnpm dev` 双端可跑，健康检查通过 |
| 0.6 | cards.cdb 导入工具原型（cards 表） | cube/api | 导入成功，查询接口可用 |

## M1 ygopro 宿主改造（可与 M2 并行）

| # | 任务 | 涉及 | DoD |
|---|---|---|---|
| 1.1 | gframe.cpp 解析位 13~16（main_min/max, extra_max, side_max），`argc>=17` 生效，调用 `SetDeckLimits` | ygopro/gframe/gframe.cpp | 带参启动生效；不带参回归 |
| 1.2 | DeckManager 运行时限制：成员 + SetDeckLimits + CheckDeck/LoadDeck 改用运行时值 | deck_manager.h/cpp | 05 验收 3 的用例通过 |
| 1.3 | 断线重连语义核对：代理断开 vs 玩家离开；补重连超时配置 | netserver.cpp | 30s 内重连成功；超时清理 |
| 1.4 | 回归：老参数组合行为不变；对局结果消息完整（供 srvpro 采集） | 全量 | 手动双客户端对局全流程 OK |

## M2 srvpro 改造（可与 M1 并行）

| # | 任务 | 涉及 | DoD |
|---|---|---|---|
| 2.1 | Room 构造器新增 `MAIN/EXTRA/SIDE` token + `normalizeDeckSize()` | ygopro-server.coffee | 规则字符串解析单测（coffee 测试或手动） |
| 2.2 | spawn 参数追加 4 位（cube 房间） | ygopro-server.coffee | 与 M1.1 联调：宿主收到正确限制 |
| 2.3 | UPDATE_DECK 固定卡组覆盖 + ID 校验（cube_mode） | ygopro-server.coffee | 客户端任意卡组被覆盖；非法 ID 被拒 |
| 2.4 | `cube.coffee`：/cube/create_room、room_status、close_room、result 路由 + api_key | cube.coffee（新） | curl 全流程 OK |
| 2.5 | room.delete() cube webhook 分支（payload 按 07-3.4，重试+ack） | ygopro-server.coffee | 结果完整送达 mock 端点；kill 后重试不丢 |
| 2.6 | default_config.json `modules.cube` + 文档；`enabled=false` 回归 | config | 存量行为不变 |

## M3 cube 后端核心（依赖 M0）

| # | 任务 | 涉及 | DoD |
|---|---|---|---|
| 3.1 | AuthModule：三要素 Guard + token 签发/哈希 | auth/ | 缺字段 401；token 不可逆 |
| 3.2 | TournamentModule 状态机 + SQLite schema 落地 | tournaments/ | 阶段迁移正确，事件全记录 |
| 3.3 | EventLogModule：append-only + 快照 + revert（含 admin-frozen） | events/ | 随机 kill 恢复一致；revert 可用 |
| 3.4 | CardModule：cdb 导入完善 + 查询 | cards/ | 中英文本可用 |
| 3.5 | DraftModule 核心：牌堆生成（drop last 公开）、蛇形轮转、30s 计时、超时随机选、幂等 pick | draft/ | API 驱动的完整选牌流程通过（集成测试） |
| 3.6 | PauseModule：发起/投票/暂停/恢复（≤5min） | draft/ | 投票规则正确；计时冻结/恢复 |
| 3.7 | DeckModule：校验规则、锁定/解锁、超时自动补/删、ydk 导出 | decks/ | 05-10.3 用例通过 |

## M4 cube 对局编排（依赖 M3.2；可与 M3.5+ 并行）

| # | 任务 | 涉及 | DoD |
|---|---|---|---|
| 4.1 | 排表引擎：单循环/瑞士轮/淘汰赛（按人数规则） | matches/ | 3~17+ 人数用例排表正确（单测） |
| 4.2 | SrvproClient + 对局状态机（scheduling/playing/reporting） | matches/ | mock 契约测试全链路 |
| 4.3 | webhook 接收 + 轮询兜底 + 异常处理（超时仲裁） | matches/ | 双通道正确；webhook 丢失恢复 |
| 4.4 | 对局阶段事件日志与回溯联动（回溯前清理 srvpro 房间） | matches+events | 管理员回溯流程可用 |

## M5 cube 前端选牌/构筑（依赖 M3.5/M3.7 的 API）

| # | 任务 | 涉及 | DoD |
|---|---|---|---|
| 5.1 | 框架：路由、三要素身份、SSE hook、状态恢复 | web/ | 刷新恢复精确状态 |
| 5.2 | 选牌页：顶栏、左侧三区（每行10/计数/拖拽/类型校验）、右侧牌堆（每行5/背面）、倒计时背景、确认弹窗 | web/ | 06-8 用例 1~4 |
| 5.3 | 构筑页：放弃区、锁定/解锁、ydk 下载 | web/ | 06-8.6 |
| 5.4 | CardImage 本地卡图（File System Access API + fallback 空白卡） | web/ | 06-8.5 |
| 5.5 | 动画打磨（选牌飞入、倒计时光效、锁定反馈） | web/ | 视觉 QA 通过 |

## M6 前端对局页 + 报名/管理页（依赖 M4）

| # | 任务 | 涉及 | DoD |
|---|---|---|---|
| 6.1 | 报名页（player id + token 展示/手动输入） | web/ | 报名流程闭环 |
| 6.2 | 对局页：对阵表、房间信息（服务器+端口+密码）、比分 | web/ | 全流程体验 OK |
| 6.3 | 管理页：阶段控制、暂停、回溯 | web/ | 管理员操作生效 |

## M7 端到端联调与部署（依赖全部）

| # | 任务 | DoD |
|---|---|---|
| 7.1 | 端到端：真机 4 玩家完整 Cube 比赛（选牌→构筑→瑞士轮） | 全流程无人工干预跑完，结果正确 |
| 7.2 | 故障演练：中断选牌 10 分钟恢复；kill cube 恢复；kill srvpro 恢复 | 恢复后状态一致 |
| 7.3 | 部署文档 + Docker 编排（cube + srvpro + ygopro + assets） | 一键部署脚本 |
| 7.4 | 安全审查（token、api_key、输入校验、SSE 越权） | 无高危问题 |
| 7.5 | AGENTS.md / dev_docs 与实际实现同步修订 | 文档与实际一致 |

## 并行性与依赖图

```
M0 ──┬──▶ M1 ────────────┐
     ├──▶ M2 ────────────┤（M1+M2 交付后联调）
     └──▶ M3 ──▶ M5 ────┼─▶ M7
          └──▶ M4 ──▶ M6┘
```

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| ygopro server 分支与 master 漂移大 | M0.1 先评估 diff；必要时把 master 关键修复合入 cube-server |
| CoffeeScript 维护/回归成本 | 改动集中在 4 个函数点；每次交付跑存量手动回归（M2.6） |
| 协议/参数不一致导致宿主崩 | 07 文档为唯一契约；M1.1+M2.2 联调先行 |
| 浏览器读本地卡图受限 | 06-5 双方案；File System Access API 优先，Safari 回退本地静态服务 |
| 对局阶段回溯副作用（srvpro 房间） | 回溯前强制清理房间（M4.4） |
| 选牌并发/重复 pick | 数据库唯一约束 + 幂等接口（M3.5） |
