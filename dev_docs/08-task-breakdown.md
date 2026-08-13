# 08 - 实施状态、验收与待办

> 状态核对：2026-08-09。✅ 表示代码已在当前 checkout 实现并有自动化覆盖；
> “待实测”表示需要真实 srvpro/客户端/部署环境，不能仅凭单元测试宣称完成。

## 1. 当前里程碑

| 里程碑 | 状态 | 当前结果 |
| --- | --- | --- |
| M0 环境与分支 | ✅ | 根仓库 + `fc-jian` 两个 fork submodule；配置、构建和 E2E 脚本在仓库内 |
| M1 ygopro | ✅ | 13--16 运行时 deck limit、`LoadSide` 运行时化、长密码、`STOC_CUBE_DECK`、客户端锁定 |
| M2 srvpro | ✅ | Cube HTTP API、deck size token/spawn、开局覆盖/siding 校验、长密码严格解析、结果 webhook |
| M3 后端核心 | ✅ | passing/serial 回放、整轮发堆、reserve/暂停冻结、构筑校验/修复、卡池/事件/回溯 |
| M4 对局编排 | ✅* | 单循环/瑞士无重复对手约束、手动赛制、webhook+轮询、DSQ/bye；双败 bracket 需真机复核 |
| M5 玩家前端 | ✅ | 独立玩家 URL、脱敏 SSE、六列牌堆、整理/随机排序、卡图 fallback、对战刷新提示 |
| M6 管理前端 | ✅ | 统一创建/编辑参数、默认卡池、token 重设、卡池字面名警告、合规确认、事件回溯 |
| M7 集成与部署 | ⏳ | 真实 4+ 人比赛、Windows 客户端 smoke、Aly SSH 部署和故障演练待环境验证 |

`M4*` 的双败实现已持久化 winners/losers/grand-final 字段，但当前配对器按胜负
组重新配对，并非完整商业 bracket；生产上线前必须用固定 seed 做整 bracket 回归。

## 2. 已完成的关键验收点

### 2.1 资源与安全

- 根仓库不再追踪 `assets/cards.cdb`、`assets/pics`、`assets/script`、
  `assets/expansions` 等个人路径符号链接；`.gitignore` 排除整个运行时 `assets/`。
- `config.yaml` 不入 Git；默认拒绝占位/重复 admin token 和空 srvpro API key。
- 玩家、管理员、srvpro webhook 均有独立鉴权路径；SSE 不广播卡组内容或其他桌房间名。

### 2.2 选牌与构筑

- 默认每堆 18 张，`packSize` 与公平性解耦；牌堆数为玩家数倍时每轮每人同样张数，
  非整轮 API 返回预计值/区间，不再误报“不公平”。
- passing 队列按轮发堆，座位随机换位后状态栏从左到右实时刷新；每人 reserve、
  超时自动选、暂停/冻结剩余时间都落事件日志。
- 构筑默认无限时；管理员手动进入对战先得到不合规报告，确认后随机把超限卡移到
  side/未使用区，main 不足下限的玩家 DSQ。
- `maxCopies>1` 允许在已选编号许可内复制卡；未使用区移出的卡会从服务器 deck
  payload 排除，卡组同步文件使用 `cube-deck-<tid>-<pid>-<timestamp>.ydk`。
- 卡池/搜索/选牌状态/详情按 exact card code 保留 alias 相关卡；只有卡组规则副本
  上限按 alias identity 归并。牌堆前端自动使用 `deck_sort_lv` 显示排序，不改服务端
  抽牌顺序。
- `cards/status` 按每次选牌前的实际剩余卡重建玩家视角；前位玩家已选走的卡不会
  被后位玩家误报为已见，返回 code 不做 alias 替换。
- 整理按钮使用与 YGOPro `deck_sort_lv` 相同的比较器；手动拖动仍保留顺序，随机
  按钮只洗 main；卡池编辑页复用同一排序逻辑。

### 2.3 卡池与元数据

- 新建/编辑支持每行 `code` 和 `code<TAB>name`；缺失编号、非法行、字面名不匹配
  均逐行报告。字面名读取 `getLiteral()`，不会把 `datas.alias` 的规则名称当原名。
- cards.cdb 导入效果文本、刻度、Link 标记、系列名；卡图不入库，使用本地 → AVIF
  → 原图只读代理 → 空白卡 fallback。

## 3. 自动化验证

在已安装依赖且 `config.yaml` 允许测试的环境运行：

```bash
cd cube/apps/api
npm run build
npm test -- --runInBand

cd ../web
npm run build

cd ../../..
git diff --check
```

E2E 探针（需要真实 API/srvpro 与外部 cards.cdb）：

```bash
bash scripts/e2e/run-e2e.sh
bash scripts/e2e/run-full-sim.sh
```

宿主/协议回归：

```bash
bash scripts/build-ygopro.sh
(cd srvpro && npx coffee -c ygopro-server.coffee cube.coffee)
git -C srvpro diff --check
git -C ygopro diff --check
```

## 4. 上线前待办

1. **Windows**：用 `C:\projects\ygopro` 的完整源码/依赖和现有 `premake5.exe`
   生成 VS2022 Release `YGOPro.exe`，确认文件大小、依赖 DLL、启动、长密码、
   `STOC_CUBE_DECK`、BO3 siding；不要交付 Debug 或中间文件。
2. **Aly SSH**：配置外部 cards.cdb/script/pics/expansions、唯一 token、CORS
   allowlist、srvpro API key；部署后执行 health、创建房间、结果 webhook 和重启恢复。
3. **真实赛制**：至少跑 4/5/8 人单循环/瑞士、奇数 bye、重复对手无解、双败完整
   winners→losers→grand final；核对 DSQ 后剩余玩家与赛制参数。
4. **CORS**：浏览器 origin 必须出现在 `server.allowed_origins`；若出现
   `CORS_ORIGIN_DENIED`，先检查实际 `Origin`（协议、域名、端口）和反代是否改写，
   不要用 `*` 绕过 credentials。
5. **故障演练**：冻结/解冻、API 重启、srvpro 重启、webhook 重试、回溯关闭房间；
   确认无重复计分、无错误恢复到旧 deck。

## 5. 变更纪律

- 协议字段先改本文件与 `07-protocol-api-design.md`，再同步 shared/API/srvpro/ygopro。
- CoffeeScript 和生成的 JS 必须同一提交；submodule 指针只在对应 fork 分支更新后 bump。
- 运行时卡牌资源、数据库、日志、缩略图和符号链接不提交；根仓库保持可复现的
  最小控制端源码和文档。
