# 04 - srvpro Cube 集成说明

> 当前实现位于 `srvpro` submodule 的 `cube` 分支（源文件和编译后的 JS 都已
> 提交）。srvpro 仍是房间代理和 YGOPro 宿主编排层；比赛业务状态由 cube API
> 保存。

## 1. 房间规则与宿主启动

`ygopro-server.coffee` 的 `Room` 构造器支持：

```text
MAIN<min>-<max> / MN<min>-<max>
EXTRA<max>      / EX<max>
SIDE<max>       / SD<max>
```

缺省值是 40/60/15/15；部分 token 会经过 `normalizeDeckSize()` 补齐其余字段。
`Room.spawn()` 在传统 12 项参数后追加四个数值 deck limit，顺序必须与
`dev_docs/03` 和 `gframe.cpp` 一致。只有含 `deck_size` 的 Cube 房间追加参数，
普通旧房间不受影响。

当前分支还把房间最终规则统一为 `lflist=-1`、`duel_rule=5`（新大师规则布局），
轮抽环境不使用禁限卡表；若部署需要传统 srvpro 规则，应使用未合入 Cube 扩展
的上游构建或另行回滚该策略。

## 2. Cube HTTP API

`cube.coffee` 由现有 HTTP listener 分派，所有请求都必须带
`X-Cube-Api-Key`，错误使用 `{ok:false, code, message?}`：

| 方法/路径 | 说明 |
| --- | --- |
| `POST /cube/create_room` | 接收 room name、hostinfo、deck size、登记玩家和固定卡组；幂等创建并等待宿主 stdout 端口 |
| `GET /cube/room_status?room_name=` | 返回 established、port、duel stage、连接玩家和 scores |
| `POST /cube/close_room` | 关闭房间并走 `Room.delete()` 结果流程 |

`create_room` 中 `players[].name_vpass` 是 YGOPro 客户端实际输入的昵称，必须是
ASCII 且与客户端一致；服务器根据 `cube_player_id_by_name` 将其映射到 Cube
player id。Cube 创建会强制 `no_check_deck=true`、开启 replay 保存，并在
宿主层仍执行运行时 deck limit/未知卡检查。

## 3. UPDATE_DECK 与客户端同步

### 3.1 开局覆盖

`UPDATE_DECK` handler 按房间的 Cube player id 查找 `cube_decks`：

- 开局忽略客户端上传内容，返回固定卡组 buffer；
- `client.start_deckbuf` 保存覆盖后的 buffer，作为断线重连比较基准；
- `mainc/sidec > 256` 直接拒绝，防止超大输入造成资源消耗。

### 3.2 siding 分流

在 `duel_stage=BEGIN` 之外，客户端上传的三区卡组若满足“各区数量与原卡组
一致、main+extra+side 多重集一致”，就原样转发；否则回退服务器固定卡组。
这与宿主 `DeckManager::LoadSide()` 的检查叠加，保证合法换 side、拒绝凭空
添加卡片以及旧客户端兼容三者同时成立。

### 3.3 STOC_CUBE_DECK

`JOIN_GAME` follow handler 在原入房消息发送完之后注入 `STOC_CUBE_DECK (0xA)`。
payload 包含 main（含 extra）/side code 和可选安全文件名，文件名由 cube API
生成并透传。合法命名格式为：

```text
cube-deck-<tid>-<pid>-<timestamp>
```

仅允许字母、数字、点、下划线和连字符；客户端会自动保存 `.ydk` 并锁定卡组
选择。重连时不重复注入，避免清除已经建立的客户端锁定。

## 4. 长 JOIN_GAME 密码

标准 48 字节包继续走原有解析。对于加长包，srvpro：

1. 验证至少 8 字节头和 UTF-16 对齐；
2. 要求 NUL 终止，最多 255 个 UTF-16 code unit；
3. 禁止 NUL 后出现非零尾部；
4. 使用扩展密码替代被 struct 截断的 `pass[20]`。

任一步失败都向客户端发送诊断错误并取消加入。这样超限房间密码不会悄悄
失效，也不会因多个可见相同前缀产生错误路由。

## 5. 结果 webhook 与重试

Cube 房间删除时，如果 `settings.modules.cube.enabled`，srvpro POST 到
`webhook_url`：房间时间、Cube player id、`name_vpass`、score、当前 deck、
deck history、first/wins 和 replay base64。请求带 `X-Cube-Api-Key`，沿用
`utility.retry` 最多重试 10 次；cube API 以 room name 幂等处理重复结果。

未启用 Cube 模块时不调用该 webhook。普通 srvpro 的 arena/challonge/云回放
逻辑保持原分支行为，但要注意当前 `cube` 分支对房间规则的 MR5/no-banlist
归一化是全局代码路径的一部分。

## 6. 配置与构建

`data/default_config.json` 的相关配置：

```json
"cube": {
  "enabled": false,
  "api_key": "",
  "webhook_url": "",
  "room_wait_ms": 10000
}
```

修改 CoffeeScript 后必须同时生成 JS：

```bash
npx coffee -c ygopro-server.coffee cube.coffee
```

启动前把匹配当前 `cube-server` 分支的宿主放在 `srvpro/ygopro/ygopro`，并另行
挂载 `cards.cdb`、`script/`、`pics/`、`expansions/`。这些资源和个人路径符号
链接不属于根仓库。

## 7. 验收清单

1. 使用 `/cube/create_room` 建房，响应含动态端口，宿主参数含 13--16 四个
   deck limit。
2. 用普通、长密码和错误长密码各加入一次；错误输入必须有明确错误。
3. 开局上传任意卡组都被固定卡组替换；siding 合法换区成功，添加未知卡失败。
4. 客户端收到 `STOC_CUBE_DECK` 后生成命名 ydk、锁定选组；旧客户端仍能靠
   server override 对战。
5. 删除房间后 webhook 带 API key 发出，cube API 重复收到同一结果不重复记分。
