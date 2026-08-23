# 03 - ygopro Cube 改造与交付说明

> 当前代码已经落在 `ygopro` submodule 的 `cube-server` 分支；客户端与无头
> 宿主共用该分支，不再维护一个未实现的 `cube-client` 分支。本文同时记录
> 已实现的协议和发布检查。

## 1. 宿主参数与运行时 deck limit

传统宿主参数为 12 项。新版 Cube srvpro 在末尾追加显式 marker 与四个限制：

| 参数 | 含义 | 默认 |
| --- | --- | ---: |
| 13 | `--cube-deck-limits` | - |
| 14 | `main_min` | 40 |
| 15 | `main_max` | 60 |
| 16 | `extra_max` | 15（Cube API 可传 30） |
| 17 | `side_max` | 15（Cube API 可传 30） |

`gframe/server_args.h` 负责纯函数解析并校验整数范围 `0--250` 与
`main_min<=main_max`；显式 marker 缺项或非法时宿主拒绝启动，不能静默退回默认值。
replay seed 从第 18 项开始。为滚动升级兼容，旧版“四个纯数字”布局仍可用，seed
从第 17 项开始；普通房间不带扩展时保持编译期默认值。seed 必须解码为精确长度，
并以相对 seed 下标写入，避免扩展参数导致越界。

`DeckManager` 的当前语义：

- `CheckDeck()` 使用运行时 min/max 和 extra/side 上限；
- `SingleDuel`、`TagDuel` 的初次装载及 `LoadSide()` 都使用同一组值；
- `LoadDeck()` 对未知 code 返回错误，对超过上限的输入截断。故 API 的构筑
  校验仍是业务上的最终上限检查，不能把“宿主没有报错”当作卡组合规证明；
- `SetDeckLimits()` 对负数或 min>max 直接忽略，避免错误参数破坏普通房间。

## 2. 客户端 Cube 卡组同步

### 2.1 `STOC_CUBE_DECK = 0xA`

`network.h` 只增加消息 ID，不修改已有 struct 或 `static_assert` 尺寸。srvpro
在 `STOC_JOIN_GAME` 刷新后排队发送消息，确保客户端先收到入房消息。payload 为：

```text
uint32 main_count（含额外卡）
uint32 side_count
uint32 main_count + side_count 个 card code
uint16 filename_length + ASCII 文件名（可选尾部）
```

`duelclient.cpp` 会做长度和文件名字符校验，按 cards.cdb 类型把 main 中的
额外卡分到 extra，保存并加载：

```text
deck/cube-deck-<tid>-<pid>-<YYYYMMDDhhmmss>.ydk
```

缺少合法文件名的旧 payload 兼容保存为 `cube-current.ydk`。成功后锁定卡组
选择控件；文件保存或加载失败时明确提示且不锁定。

### 2.2 siding

进入 siding 时保存服务器同步卡组快照。客户端只允许在 main/extra/side 三个
区域的总多重集不变时调整分区；`srvpro` 同样验证各区数量与总多重集，合法时
原样转发，非法时恢复服务器卡组。这样打补丁与未打补丁客户端都能完成 BO3。

## 3. 长房间密码

标准 `CTOS_JoinGame` 的 20 个 UTF-16 code unit 保持兼容。客户端对更长密码
发送 8 字节头（version/padding/gameid）+ UTF-16LE 密码 + NUL，最多 255 个
UTF-16 code unit；Unicode 编码失败、超限或密码尾部异常会在客户端/服务器
显式报错。srvpro 不再静默使用被截断的 `pass[20]`，因此 Cube 长房间名/密码
不会错误失效或串房。

## 4. 构建与验证

### 4.1 Linux 无头宿主

```bash
bash scripts/build-ygopro.sh
```

脚本使用 `envs/tools/premake5` 和 `envs/ygocube`，输出
`ygopro/bin/release/ygopro`；部署时复制到 `srvpro/ygopro/ygopro`。启动示例：

```text
./ygopro 0 -1 0 1 5 T F 8000 5 1 180 1 --cube-deck-limits 40 60 30 30
```

宿主应打印动态端口，且通过 12 项旧参数启动时行为不变。

版本协议号 `PRO_VERSION` 始终保持与合入的上游一致；Cube 身份只追加显示/文件
版本后缀。本轮基于上游 `1.036.2`，客户端标题与 Windows 字符串版本为
`1.036.2-cube`，数值 `FILEVERSION/PRODUCTVERSION` 和网络主版本不另起分叉。

### 4.2 Windows GUI 客户端

在 WSL 中准备源码/依赖后，可用已有 `premake5.exe` 生成 VS2022 工程；
`scripts/build-ygopro.sh --client --no-audio --max-extra=30 --max-side=30`
是 Linux 交叉联调等价配置。Windows 发布必须确认：

1. premake 生成的是 `vs2022`、`Release`、`YGOPro` 目标；
2. `YGOPro.exe` 与 DLL/资源来自同一构建，不是 `.obj` 或 Debug 中间文件；
3. 运行目录含 `cards.cdb`、`script/`、`expansions/` 和 `pics/`（这些资源不在
   根 Git 仓库）；
4. 启动、加入普通房间、加入 Cube 长密码房间、接收 `STOC_CUBE_DECK` 和 BO3
   siding 都做一次烟测。

Linux 有声 GUI 联调使用 `scripts/build-ygopro.sh --client --build-freetype
--build-png --build-jpeg --build-opus-vorbis`；需要与上游 CI 一致的 miniaudio、
Ogg/Opus/Opusfile/Vorbis 源码。验收生成的 `YGOPro.make` 必须同时含
`YGOPRO_USE_AUDIO`、`YGOPRO_USE_MINIAUDIO` 和
`YGOPRO_MINIAUDIO_SUPPORT_OPUS_VORBIS`，不能仅凭产物文件名判断声音已启用。

### 4.3 协议回归

- `network.h` 结构大小检查必须通过；srvpro `data/proto_structs.json` 不应
  因 deck limit 或长密码扩展而改旧字段。
- 新客户端连接旧 srvpro 时，短密码和普通对局仍可用；旧客户端连接新 srvpro
  时会忽略 0xA，但开局 deck override 仍生效。
- 失败的宿主启动、文件写入和非法 payload 必须返回可诊断日志，而不是静默
  建立一个使用默认上限的房间。

## 5. 相关文件

| 文件 | 责任 |
| --- | --- |
| `gframe/gframe.cpp`、`server_args.h` | 解析显式/legacy 限制参数、校验 replay seed |
| `gframe/deck_manager.h/.cpp` | 运行时限制、LoadDeck/LoadSide |
| `gframe/network.h` | `STOC_CUBE_DECK` ID |
| `gframe/duelclient.cpp` | 长密码、同步卡组、锁定与 siding 快照 |
| `gframe/deck_con.cpp`、`menu_handler.cpp` | UI 锁定与 side 校验 |
| `scripts/build-ygopro.sh` | Linux 宿主/客户端构建入口 |
