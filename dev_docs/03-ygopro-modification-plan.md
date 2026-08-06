# 03 - ygopro 改造方案（宿主二进制 + 可选客户端）

> 目标代码库：`mycard/ygopro`。**分支策略**：新建 `cube-server`（基于 `origin/server`）承载无头宿主改造；客户端改造（如需）基于 master 建 `cube-client`。禁止直接改 master/server。

## 1. 需求与现状对照

| 需求 | 现状 | 结论 |
|---|---|---|
| deck size（main/extra/side）动态可配置 | 编译期常量（deck_manager.h:17-20） | **必须改**：宿主按 spawn 参数运行时生效 |
| 固定卡组自动加载 + 验证 ID | 宿主接收客户端 CTOS_UPDATE_DECK，CheckDeck 校验 | 卡组覆盖逻辑放 srvpro（见 04 文档）；宿主侧确保 CheckDeck 使用运行时限制即可 |
| 断线重连 | netserver 有玩家状态保持；srvpro 侧有 reconnect 模块 | 验证宿主侧重连窗口与 srvpro 配合，必要时补超时配置 |
| 比赛结果自动获取 | 宿主发送胜负消息（STOC_DuelEnd / chat），srvpro 解析 | 宿主侧无需改动；srvpro 采集（见 04） |

## 2. 改动清单（均基于 `cube-server` 分支）

### 2.1 宿主启动参数扩展：deck size 运行时化

**文件：`gframe/gframe.cpp`（server 分支的 main()）**

- 现有参数位 1~12（见 02-1.4），13+ 为 match seed。**新增尾部参数位 13~16**（顺序与 srvpro 一致，缺省时回退常量）：

| 新参数位 | 含义 | 缺省 |
|---|---|---|
| 13 | main_min | 40 |
| 14 | main_max | 60 |
| 15 | extra_max | 15 |
| 16 | side_max | 15 |

- 解析后写入全局配置（如 `host_info` 扩展字段或 `deckManager.SetDeckLimits(...)`）。
- 兼容性：srvpro 仅在 cube 模式房间追加这些参数；老 srvpro 不带参数 → 回退常量，行为不变。
- **注意**：`argc >= 13` 的判定条件需调整为 `>= 17` 才读取新参数；老二进制/新 srvpro 或新二进制/老 srvpro 组合都不崩溃（新二进制对 argc 13~16 视为无扩展参数）。

### 2.2 Deck 校验运行时限制

**文件：`gframe/deck_manager.h` / `gframe/deck_manager.cpp`**

- 在 `DeckManager` 增加成员：`int deck_main_min, deck_main_max, deck_extra_max, deck_side_max;` + `bool deck_limits_set;` + `void SetDeckLimits(...)`（非法输入回退默认，不置位）。
- `CheckDeck()`（deck_manager.cpp:90-95）改用成员值（替代常量）；`LoadDeck()` 的填牌逻辑（:172-192）改静态参数 `main_max/extra_max/side_max`（LoadDeck 是 static，不能访问实例成员——由调用方传入 `deckManager.deck_main_max` 等）。
- 调用点（server 分支 single_duel.cpp:428 / tag_duel.cpp:403）传入运行时限制。
- `LoadSide()`（match 模式局间换 side）同样必须使用运行时限制：其内部 `LoadDeck` 若用静态默认值会把超限卡组截断，导致尺寸一致性检查失败（ERRMSG_SIDEERROR）、BO3 第二局卡死。
- 初始化：构造时用常量默认值，`main()` 解析参数后调用 `SetDeckLimits`。
- 不变式：`main_min >= 0 && main_min <= main_max`，非法输入回退默认。
- **实测语义（重要）**：`LoadDeck` 对超过上限的卡**截断丢弃**，所以 `CheckDeck` 实际只会报 main 低于下限（MAINCOUNT）与未知卡（UNKNOWNCARD）；上限靠截断保证合法。上层（srvpro/cube）负责 max 侧的业务校验。

### 2.3 协议与数据通道

- **无需修改 network.h 消息结构**：deck size 走 spawn 命令行参数，不进游戏协议，天然向后兼容，也不影响 `static_assert` 校验。
- 若未来需要客户端显示自定义限制：新增 `STOC_*` 字段走 `host_info` 同步（需同步 `data/proto_structs.json`），**本阶段不做**（玩家用 ydk 进房，客户端本地限制用 `no_check_deck=T` 绕过）。

### 2.4 断线重连（验证 + 补齐）

- 核对 netserver 对玩家断线（socket close）后的保留策略：玩家位置、手牌/场况、超时重连窗口。
- 需要确认项：重连窗口是否可配置（srvpro `modules.reconnect` 负责上层策略，宿主侧需容忍 srvpro 的代理重连——代理 socket 断开≠玩家离开）。
- 若宿主对代理断开即清理玩家，则与 srvpro 重连模块冲突，需要把"代理短暂断开"与"玩家掉线"区分（可通过 srvpro 重连期不关闭代理连接实现，倾向优先在 srvpro 侧解决，宿主仅补超时）。

### 2.5 结果输出（验证项）

- 宿主每小局结束已有胜负消息，srvpro 解析（`room.scores`）。验证 match 模式（BO3）整场结束信号的完整性即可，预计无需改动。

## 3. 客户端侧（可选，`cube-client` 分支，默认不做）

- 场景：cube 允许自定义 main 上下限（如 50~60）时，玩家在客户端卡组编辑器（deck_con.cpp:1778-1806）会看到 40/60 的旧限制提示。
- 方案：客户端从 `STOC_CREATE_GAME/host_info` 读取限制并显示；或依赖 srvpro 的 `no_check_deck=T` + 宿主强制。
- **决策**：第一版不改造客户端，srvpro 建 cube 房间时强制 `no_check_deck=T`，由宿主（2.2 运行时限制）兜底校验。

## 4. 构建与交付

- Linux 部署机：`premake5 gmake2` → `make config=release` → 产物 `bin/release/YGOPro`（重命名为 `ygopro` 放入 `srvpro/ygopro/`）。
- Windows 本地联调：`premake5 vs2022` 或按 README 的 CI 流程；产物同样命名 `ygopro.exe`。
- 版本标记：保持 `gframe/config.h` 的 `PRO_VERSION` 同步（srvpro 启动时读取做版本校验，见 ygopro-server.coffee:440），**改动协议/参数必须 bump**。

## 5. 验收标准

1. `./ygopro 0 -1 0 0 3 F T 8000 5 1 180 0 40 50 10 5` 这类带 4 个扩展参数的启动可正常建宿主，且 stdout 打印端口。
2. 不带扩展参数启动时行为与改动前完全一致（回归）。
3. 运行时限制生效（实测，见 scripts/e2e/run-e2e.sh）：39 张主卡组（main_min=40）被拒（MAINCOUNT）；55 张被截断为 50 张通过；未知卡 ID 被拒（UNKNOWNCARD）；`no_check_deck=T` 的 cube 房间仍执行上述校验（`deck_limits_set` 强制）。
4. 客户端断线 30s 内重连可回到对局；srvpro 代理重连不被误判为玩家离开。
5. 对局正常结束，srvpro 能收到完整比分/结果数据。

## 6. 相关文件清单

| 文件 | 改动 |
|---|---|
| `gframe/gframe.cpp`（cube-server 分支） | 参数解析 13~16 + 调用 SetDeckLimits |
| `gframe/deck_manager.h` | 新增成员与 SetDeckLimits 声明 |
| `gframe/deck_manager.cpp` | CheckDeck / LoadDeck 使用运行时限制 |
| `gframe/netserver.cpp`（验证） | 断线保留窗口/代理断开语义 |
| `gframe/config.h` | 版本号（如协议/参数变化时） |
