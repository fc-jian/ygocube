---
name: update
description: Safely synchronize YGOPro upstream card resources and the current official Super Pre expansion by default, build/test the Cube stack, and deploy or roll back Aly releases.
---

# YGOPro 资源更新

当任务涉及 `mycard/ygopro/server` 上游、`cards.cdb`、脚本、卡图、YGOPro
宿主/客户端构建、官方先行卡 expansion 或 Aly 资源发布时使用本 Skill。资源更新的唯一编排入口是
[`scripts/update-card-resources.sh`](../../../scripts/update-card-resources.sh)；不要
用临时脚本直接覆盖运行时目录。先读仓库根目录的 `AGENTS.md`，接口或协议变更
还要先读 `dev_docs/07-protocol-api-design.md`。

## 不可破坏的约束

- 根仓库的同步分支必须是 `codex/card-resource-sync-*`；绝不在 `main`/`master`
  或上游主分支直接合并。
- `ygopro` 子模块必须使用对应的 feature 分支，不能改其 `main`/`master`。
  `srvpro` 与上游的长期分叉不做整分支机械合并；只按审计结果移植必要修复。
- 上游合并使用 no-ff、先不提交的方式；C++、`cards.cdb`、gitlink 或协议冲突
  必须人工解决。不得用 `ours`、`theirs`、`reset --hard` 或强制推送掩盖冲突。
- 运行时的 `assets/`、数据库、原始 `pics/`、日志和 `.card-resource-sync/` 不入 Git。
  Aly 只发布低清 AVIF、`cards.cdb`、`strings.conf`、受清单管理的 Lua 和必要的
  无头宿主二进制；原始卡图永不上传。先行卡只发布服务器需要的
  `srvpro/ygopro/expansions` 内容，不把客户端 `.ypk`、`pack/*.ydk` 或
  `corres_srv.ini` 上传到运行目录。
- 资源清单、日志、事件和 URL 不得含 token、密码、私钥、绝对本地路径或完整请求
  头。SSH 凭据只从已有 `aly` 别名/SSH 配置取得。
- 更新脚本优先使用已配置的 SSH helper；本机没有 helper 时使用系统 `ssh`/`scp`
  和同一别名，不复制或读取私钥内容。
- 发布会中断服务并影响进行中的比赛。只有用户明确确认维护窗口后，才运行带有
  `--confirm-maintenance` 的 deploy；失败时保留 staging 和备份，不能先清理。

## 标准成功路径

以下步骤按顺序执行；每一步失败都停止，不跳过前置验收。命令均从仓库根目录
执行。

### 1. 建立可审计的更新分支

```bash
git status --short --branch
git submodule status --recursive
git remote -v
git switch -c codex/card-resource-sync-YYYYMMDD
git -C ygopro status --short --branch
```

上游同步/合并前必须确认目标没有未处理的用户改动。针对已授权功能进行修复和发布时，
先记录工作区范围，保留已有改动；不要把 dirty 状态当作停止所有诊断与测试的理由。若已经存在同名分支，切换到
它而不是覆盖；不要替用户 stash、删除或重置未提交内容。若子模块是 detached，
在该 feature 分支创建与根分支同名的本地分支，并确认指向的是 Cube fork。

### 2. 确认上游和依赖版本

规范源是 `https://github.com/mycard/ygopro.git` 的 `server` 分支。先只读查询并
人工查看提交说明、父提交和资源变化：

```bash
git ls-remote https://github.com/mycard/ygopro.git refs/heads/server
bash scripts/update-card-resources.sh check
git -C ygopro log --oneline --decorate -8
git -C ygopro diff --stat HEAD..FETCH_HEAD  # 仅在本地已 fetch 时使用
```

把经过审查的完整 40 位 SHA 明确传给脚本，不要盲信脚本中为历史更新保留的默认
值：

```bash
export YGOPRO_UPSTREAM_REPO=https://github.com/mycard/ygopro.git
export YGOPRO_UPSTREAM_REF=server
export YGOPRO_UPSTREAM_COMMIT=<reviewed-full-sha>
```

同时从上游提交/`.gitmodules`/构建文件确认 `script` 和 `ocgcore` 的预期 gitlink，
并设置（或检查）`YGOPRO_SCRIPT_COMMIT`、`YGOPRO_OCGCORE_COMMIT`。若上游 ref
在查询和实际 fetch 间变化，重新固定 SHA，不使用漂移的分支名继续。

### 3. 同步 YGOPro，保留人工冲突点

先做不修改的演练，再执行 no-ff 合并：

```bash
bash scripts/update-card-resources.sh --dry-run sync
bash scripts/update-card-resources.sh sync --commit
```

脚本会 fetch 固定 SHA、验证 `script`/`ocgcore` gitlink，并在冲突时退出且保留
合并现场。出现冲突时：

1. `git -C ygopro status` 和 `git -C ygopro diff --name-only --diff-filter=U` 列出
   所有冲突，不要只看 `cards.cdb`。
2. 阅读 Cube 改动与上游改动后逐个编辑；协议结构、宿主参数、版本号和资源文件
   需要两侧语义一致。二进制 `cards.cdb` 或不确定的 C++ 冲突必须交给人工维护
   者确认，禁止自动选一侧。
3. 解决并暂存所有路径后继续：

   ```bash
   git -C ygopro diff --name-only --diff-filter=U
   bash scripts/update-card-resources.sh sync --continue --commit
   ```

   `--continue` 仍发现未解决路径时再次停止。无法可靠解决时保留现场并请求
   决策；只有确认没有需要保留的用户改动后才考虑手动 `git merge --abort`。

合并完成后核对：

```bash
git -C ygopro log --oneline -1
git -C ygopro ls-tree HEAD script ocgcore
rg -n 'PRODUCT_VERSION|VERSION|cube' ygopro/gframe/config.h ygopro/premake 2>/dev/null
```

Cube 版本显示后缀必须保留 `-cube`（或项目约定的末尾 `cube`），主版本号与
上游一致。确认根仓库稍后只提交新的 `ygopro` gitlink，不把 submodule 内部文件
复制到根仓库。

### 4. 准备并审计卡库、脚本和卡图

资源输入应来自已经合并的 `ygopro/cards.cdb`、`ygopro/script/`、匹配版本的
`strings.conf` 和指定语言的上游图片归档。默认语言为 `zh-CN`；需要稳定重试时
可设置外部缓存目录：

```bash
export YGOCUBE_CACHE_DIR=/tmp/ygocube-card-resources
bash scripts/update-card-resources.sh --dry-run prepare --skip-images
bash scripts/update-card-resources.sh prepare --refresh-names
```

`prepare` 会完成以下检查，任何一项失败都不能发布：

- `cards.cdb` 是可读的 SQLite，`datas`/`texts` 存在，记录数、代码集合、SHA-256
  和增删改统计写入 `.card-resource-sync/cdb-diff.json`。
- 脚本只同步新增/修改的 Lua；删除清单只删除上次由本管线管理的文件，未知扩展
  文件保留。`strings.conf` 与 CDB 一起更新。
- 图片下载必须是 HTTPS，校验 ETag/大小/哈希、ZIP 完整性、条目数量、CRC、路径
  穿越、绝对路径、符号链接、重复编号和解压总大小；`vips` 生成最大边 200、
  Q30、去元数据 AVIF。只生成卡图编号对应的文件，原始图片留在本地缓存。
- 名称映射按 exact code 读取：`sc_name` → `md_name` → `jp_name` → `cn_name` →
  `en_name`；都为空或映射缺失时回退同一编号的 `cards.cdb texts.name`。YGOPro
  `TYPE_TOKEN` 衍生物不进入搜索、卡池或名称覆盖审计，因此其外部译名缺失可忽略。
- `prepare --refresh-names` 每次读取 YGOCDB 的 `cards.zip.md5`，按其公布的
  `cards.json` MD5 校验缓存/下载归档后再合并 exact-code 映射；MD5、归档 SHA-256、
  记录数及映射文件哈希写入清单。主卡库与 Super Pre CDB 都要通过名称覆盖审计。
- 禁限卡表来源为同一固定 SHA 的上游 `ygopro/lflist.conf`。准备流程将它分别安装到
  `srvpro/ygopro/lflist.conf` 和 `srvpro/ygopro/expansions/lflist.conf`，并在 manifest
  的独立 `banlist` 段校验哈希；即使传入 `--skip-expansion`，禁限表仍同步更新。
- 新增/变更的非衍生物仍缺名称时，读取 `.card-resource-sync/missing-names.json`，
  优先重新运行 `--refresh-names` 并检查确实是 exact code。只有记录了编号、原因和
  影响范围的人工审计例外才可以显式使用 `--allow-missing-names`；不能用它隐藏
  大批缺失。

#### 官方先行卡 expansion（标准资源更新默认同步）

官方 srvpro 的先行卡包由 [srvpro 先行卡功能](https://github.com/mycard/srvpro/blob/master/README.md)
和 [Super Pre 页面](https://mycard.world/ygopro/arena/#/superpre)提供。每次标准卡池更新
都同步当前官方 Super Pre 包与列表；编排脚本默认启用该输入，因此标准流程直接运行
`check`、`prepare` 和 `deploy` 即会检查、准备并发布上游版本。`--expansion` 仅为兼容旧命令
保留。只有用户明确要求保留 Aly 当前先行卡版本时，才传 `--skip-expansion`，并核验
expansion 差量为空：

```bash
bash scripts/update-card-resources.sh check
bash scripts/update-card-resources.sh prepare --refresh-names
```

脚本默认读取官方 HTTPS 地址：

- `ygopro-super-pre.ypk`：服务器扩展包；
- `test-release.json`：先行卡列表和展示元数据。

也可以通过 `YGOCUBE_EXPANSION_URL`、`YGOCUBE_EXPANSION_LIST_URL` 或
`--expansion-url` 指定经过审查的 HTTPS 镜像；只覆盖 `.ypk` 时仍会校验默认列表。
扩展包先检查 Content-Length/类型、ZIP 中央目录、CRC、条目数、解压总量、路径穿越、
重复规范路径、符号链接和合法文件名。列表必须是有上限的 JSON 数组，名称/效果/图片
URL 字段长度受限且图片 URL 只能使用 HTTPS。

`.ypk` 在本地解压后只安装以下受管理资源：根目录的 `*.cdb`、`*.conf`、`script/*.lua`、
`pics/<code>.*` 和 `pics/field/<code>.*`。`test-release.cdb`、`test-update.cdb` 会
分别保留并由 YGOPro 的 `LoadExpansions()` 加载；它们不会合并进主
`cards.cdb`，也不改写用户已保存的卡池/外部名称映射。API 必须把扩展卡加入可搜索
目录；不能把“宿主能够加载”误当作“网页已经支持”。原始 `pics/` 仅作为本地
AVIF 输入，远端发布清单与归档必须排除它们。`pack/*.ydk`、`corres_srv.ini`、列表 JSON
等客户端/展示元数据只做校验和清单记录，不会进入服务器 expansion 目录。
脚本在 `.card-resource-sync/resource-manifest.json` 中保存
`expansionArchive`（URL、列表 URL、ETag、SHA-256、条目和列表计数）及
`expansions.files`。先行卡差量与脚本一样只删除上次清单管理且本次确实移除的文件，
未知本地文件保留；用户显式传入 `--skip-expansion` 时不生成 expansion 删除清单，保留
Aly 上现有的先行卡。无论默认更新还是旧 `--expansion` 别名，`lflist.conf` 都不得被删除。

检查清单和摘要：

```bash
python3 scripts/card_resources.py validate-cdb ygopro/cards.cdb
cat .card-resource-sync/cdb-diff.json
cat .card-resource-sync/missing-names.json
python3 - <<'PY'
import json
from pathlib import Path
p = Path('.card-resource-sync/resource-manifest.json')
m = json.loads(p.read_text())
print('cards', m['cards']['codeCount'], m['cards']['sha256'])
print('lua', len(m['scripts']['files']), 'avif', len(m['avif']['files']))
print('upstream', m.get('upstream'))
PY
```

状态目录是审计产物而不是提交内容；在发布前另存其 manifest、CDB diff、缺失名称
报告和图片归档哈希。`--skip-images` 只适用于没有图片环境的本地诊断，不能作为
正式资源发布的替代。

### 4.1 先行卡必须贯通 API、卡图与对战

1. 读取每个实例**实际配置**中的 `server.cards_cdb`、`strings_conf`、名称映射、
   AVIF 路径及 srvpro 的工作目录；不要仅检查仓库或猜测 `/shared` 路径。
   API 与该实例的新宿主必须使用同一资源代；尤其检查是否固定指向旧 release。
2. API 按主 CDB → 同级 `expansions/*.cdb` 文件名顺序读取，后加载同编号覆盖。
   不合并原始 CDB。元数据重建应先读取全部源，再事务替换缓存；坏库不得清空旧缓存。
   实际发布后重启 API 使缓存重建，不能只重启 Web。
3. 搜索、编号查询、主卡池/候选池、卡组 main/extra/side 判断、对局元数据共用完整
   索引。名称遵循 exact-code fallback，索引与查询都做 NFKC；测试全角字母/符号
   名称，且继续拒绝 TYPE_TOKEN 入搜索和卡池。
4. 对局效果提示 `code * 16 + slot` 与录像快照也须读取扩展库；同编号覆盖为空时
   不保留主库旧选项。仅验证卡名/主描述不够。
5. AVIF 生成输入包含已安装 `expansions/pics`，普通更新也保留其图片；源图变更时
   不得因旧 AVIF 的文件哈希相同而跳过重编码。重复执行幂等、撤回卡清理只触及受管理文件。
6. 逐张核验扩展卡按编号和**显示全名**搜索、入临时测试卡池及脚本/低清卡图覆盖；
   对局描述与 CDB 全量比对。使用隔离数据库，不能在生产用户卡池制造测试数据。

`/duel/decks` 由独立 Duel Web 提供，搜索请求走 `/duel-api/public/duel/search`，其
API 和卡库 release 位于 `/opt/ygoduel`；不能用 Cube 的 `/api` 搜索结果代表该页面。
标准 `deploy` 在 `/opt/ygocube` 资源发布成功后，还会把同一代主 CDB、Super Pre、
脚本、两处 `lflist.conf`、AVIF 与 YGOCDB 映射安装到新的独立 Duel release，并使其
卡片元数据缓存失效。部署前若发现独立 Duel 的 `ygopro` 宿主仍运行则中止，避免中断
进行中的独立对局；失败时将两套资源一并回滚。验收必须经 `/duel-api` 按编号和完整
卡名逐张搜索 Super Pre 卡，并确认 `/duel-api/public/duel/options` 包含上游最新 OCG
与 TCG 禁限表。

### 4.2 Cube 与独立 Duel 是两个发布目标

- 标准资源 deploy 分别更新 `/opt/ygocube` 和 `/opt/ygoduel`，两边各自备份、校验和
  回滚；分别记录两套 API、srvpro、宿主与资源路径、哈希及健康结果。
- Cube 保持既有建房和原生客户端模式，独立 Duel 的端口、数据库、Web 网关和
  特有宿主参数必须保留。不得以复制 Cube 的整个应用或宿主二进制替代独立发布。
- 独立资源在新 release 中准备并校验，API 配置应指向稳定的 current 或受管理
  资源路径，不能永远固定首个 release。避免在运行目录直接覆盖 Lua/CDB。
- 资源和 API 同时修复时走完整应用发布：备份数据库/配置/current，验证完整包，
  原子切换，按影响范围重启，并具备回滚。不得为 API 修改重启无关 Web、Nginx
  或 Cube 宿主；确需中断的范围应在维护授权上下文中说明。
- 本轮提供 `scripts/stage-expansion-catalog.py`（仅隔离验收）和
  `scripts/deploy-expansion-catalog.py`（明确维护参数的应用修复发布）。其中路径、
  release 和样本属于本次迁移，后续使用前必须更新并审查，不能重复运行已存在的 release。

### 5. 构建无头宿主和（可选）客户端

若上游合并触及 C++、premake、ocgcore、网络协议或任何二进制依赖，执行：

```bash
bash scripts/update-card-resources.sh build
```

脚本会验证产物是 ELF、动态链接器存在（静态构建除外）、`ldd` 没有 `not found`，
保留 `-cube` 版本后缀，并把宿主复制到 `srvpro/ygopro/ygopro`。只有确认是纯
资源变化且已有兼容宿主时才可显式 `--skip-build`，并在发布记录中说明理由。

需要 GUI 客户端时另外执行并验收：

```bash
bash scripts/update-card-resources.sh build --client
# 或按构建机依赖显式补齐 --build-freetype/--build-png/--build-jpeg/--build-opus-vorbis
```

这条命令默认是当前 WSL/Linux 工具链；Windows 客户端必须在
`C:\projects\ygopro` 的 Cube feature 分支使用现有 `premake5.exe` 与 VS2022
工作流构建。生成 VS2022 解决方案时不要传 `--no-audio`，确认 miniaudio/Ogg/
Opus/Vorbis 等实际链接到 Release 配置；用 PE 架构检查、依赖检查和启动 smoke
test 验证，而不是只看编译命令成功。若二进制明显小于已知成功产物、音频依赖未
解析或版本后缀丢失，立即停止，不把该客户端放入发布包。

#### Windows Cube 客户端容量参数验收

- Windows 完整客户端使用仓库的 `scripts/build-ygopro-client.ps1`，默认源码目录为相邻 `../ygopro`、分支为 `cube-server`，默认 extra/side 各 30；需要更大容量时显式传入 `-MaxExtra` / `-MaxSide`，与目标比赛约定一致。
- 每次构建必须重新生成 VS 工程，显式传 `--max-extra=30 --max-side=30`（或本次约定的容量）及完整音频参数。仅运行 MSBuild 会复用旧工程；`1.036.2-cube` 后缀只能证明代码版本，不能证明容量宏正确。
- 构建前核对 Release|x64 的 `YGOPRO_MAX_EXTRA`、`YGOPRO_MAX_SIDE` 和音频宏，缺项直接失败。未传容量参数时源码默认 15，会导致组卡/普通加载截断；Cube 推送后保存并重新加载也经过这条路径。
- 用超出 15 张的真实 YDK 在本次生成的 exe 内打开，核验界面 main/extra/side 实际数量。2026-09-10 回归夹具为 40/30/30；记录新 exe 路径、SHA-256 和实际运行验证，不把头文件常量或项目配置单独当作二进制验收。

### 6. 完成本地测试和提交审计

标准测试入口会运行资源 helper、Cube API/Web、srvpro 构建和两个真实流程探针：

```bash
bash scripts/update-card-resources.sh test
```

每次标准更新都启用先行卡。完成默认的 `prepare` 后，先完成 archive/list 验收，
再把扩展卡资源纳入本地测试：

```bash
python3 scripts/card_resources.py validate-expansion-zip /path/to/ygopro-super-pre.ypk
python3 scripts/card_resources.py validate-expansion-list /path/to/test-release.json
EXPANSION_CODE=100268001 STANDALONE_ONLY=1 STANDALONE_MATCH=1 node scripts/e2e/web-duel-smoke.cjs
EXPANSION_EFFECT=1 STANDALONE_ONLY=1 STANDALONE_MATCH=1 node scripts/e2e/web-duel-smoke.cjs
bash scripts/update-card-resources.sh test --skip-e2e
```

测试必须确认 `test-release.cdb`、`test-update.cdb` 均能通过 SQLite 校验，扩展脚本
进入 `srvpro/ygopro/expansions/script`，低清卡图进入 API 的 AVIF 目录；原图、
客户端 `pack/` 与 `corres_srv.ini` 不在发布归档，
重复 `prepare --refresh-names` 的 expansion manifest 和受管理文件哈希稳定。
在隔离 API/数据库中检查新扩展卡可搜索、编号查询和卡图可用，并用当前包中的固定夹具
（默认 `100268005`）实际执行至少一个扩展卡效果；正式发布前仍需补跑完整 Cube E2E
和 BO3 模拟赛。

服务尚未启动时可以先运行：

```bash
bash scripts/update-card-resources.sh test --skip-e2e
```

但正式发布前必须启动兼容的 API/srvpro，再补跑 `bash scripts/e2e/run-e2e.sh`
和 `bash scripts/e2e/run-full-sim.sh`。最后执行：

```bash
git diff --check
git status --short --branch
git submodule status --recursive
```

根仓库提交应包含审查后的代码、文档和新的 `ygopro` gitlink；运行时卡库、图片、
数据库、缓存和 manifest 状态目录不应出现在 `git status`。先推送 submodule fork
feature 分支，再推送根 feature 分支；只使用普通 push，禁止 force push。是否合并
到 `main` 按项目评审流程决定，合并前不要在 `main` 上重新运行 `sync`。

### 7. 维护窗口内发布 Aly

先确认 SSH 和目标没有错：

```bash
ssh aly 'hostname; test -d /opt/ygocube; systemctl is-active ygocube-api ygocube-srvpro ygocube-web nginx'
```

默认目标为 `aly`、`/opt/ygocube`；如环境不同，显式设置
`YGOCUBE_ALY_HOST`、`YGOCUBE_ALY_ROOT`、`YGOCUBE_ALY_URL`。维护窗口尚未获授权时先准备可验收的修复包，再请求确认；同一会话用户已确认
“完成更新/继续发布”且上下文明确包含服务重启时，不重复询问。确认后运行：

```bash
bash scripts/update-card-resources.sh deploy --confirm-maintenance
# 仅用户明确要求保留 Aly 当前 Super Pre 版本时才加 --skip-expansion
```

标准资源更新默认在 `check`、`prepare` 和 `deploy` 中同步 Super Pre，确保检查、准备和发布
使用同一官方 `.ypk` 与列表版本。只有用户明确要求保留现有 Super Pre 时才传
`--skip-expansion`；此时核对 `deletes/expansions.txt` 为空且发布 manifest 保留远端
expansion 清单。即使已有 `deployed-resource-manifest.json`，也不能因此跳过上游检查。
兼容参数 `--expansion` 仍可显式启用默认行为。

Cube 资源发布的远端顺序是：取得发布锁 → 停止 Cube API/srvpro/Web/Nginx → 对 SQLite 做
WAL checkpoint 和 `PRAGMA integrity_check` → 备份数据库（含 WAL/SHM）、配置、
宿主资源、AVIF、名称映射和旧 manifest → 校验上传归档的路径/链接/类型/大小 →
在 staging 中展开并验证 SHA（包括启用时的 expansion 文件和删除清单）→ 原子切换资源目录 → 使卡片元数据缓存失效 → 按
API → srvpro → Web → Nginx 启动。输出中的 release/backup ID 必须保存，例如：

```text
/opt/ygocube/backups/card-sync-<release-id>/
```

随后独立 Duel 发布器以同一 ID 在 `/opt/ygoduel/releases/card-sync-<release-id>/`
准备资源 release，备份独立 Duel 数据库、私有配置和旧 `current` 目标，确认没有活动
宿主后仅重启 `ygoduel-api` 与 `ygoduel-srvpro`。Web、Nginx 和 Cube srvpro 不因这一步
重启。其备份保存在 `/opt/ygoduel/backups/card-sync-<release-id>/`。两步任一失败或
发布后校验失败都通过同一 ID 回滚两套资源。

本 Skill 的 deploy 更新 Cube 与独立 Duel 两套卡片资源和无头宿主；如果同一变更还包含 API/Web 代码，
使用项目的完整应用发布流程，并确保 standalone Web 同时安装 `.next/static`
和必要的 `public`，不能用首页 200 掩盖静态资源 404。

### 8. 发布后验收与记录

脚本自带的健康检查通过后，仍从 Aly 现场和公网各做一次只读验证。记录以下值：
根仓库 commit、`ygopro`/script/ocgcore commit、CDB/manifest SHA-256、release ID、
backup 路径、构建 hash 和测试日志。确认失败发布的 staging/备份仍保留。

```bash
# 本地或通过 SSH 执行
curl --fail --silent --show-error "$YGOCUBE_ALY_URL/api/health"
ssh aly 'systemctl is-active ygocube-api ygocube-srvpro ygocube-web nginx'
ssh aly 'systemctl is-active ygoduel-api ygoduel-srvpro ygoduel-web'
ssh aly "ldd /opt/ygocube/shared/srvpro/ygopro/ygopro | grep -F 'not found' && exit 1 || true"
```

公网首页和 `/duel/decks` HTML 中引用的每个 `/_next/static/*.js`、`*.css` 都必须返回 200，且 JS
为 JavaScript MIME、CSS 为 `text/css`；检查新卡片 API、`/pics/<code>.avif`、
Cube `/api` 与独立 Duel `/duel-api` 搜索、最新禁限表、`/pics/<code>.avif`、
srvpro HTTP/TCP/Cube 协议探针和实际宿主启动。两套数据库完整性、七个 systemd 服务、
资源 hash、音频客户端（若构建）均通过后才宣布成功。

## 失败处理和常见问题

| 现象 | 处理方式 |
| --- | --- |
| `refusing to modify main/master`、工作区 dirty | 保存用户改动后从干净提交创建 `codex/card-resource-sync-*`；不要由 Skill 自动 stash/reset。 |
| `ygopro` detached、在错误 fork 或主分支 | 检查 remote 和 submodule branch，建立匹配 feature 分支；确认后再 sync。 |
| 上游 SHA 不存在或 ref 已变化 | `git ls-remote`/fetch 后重新审查并固定完整 SHA；不要使用移动的 branch 名作为发布依据。 |
| C++、CDB、gitlink、协议冲突 | 保留合并现场，逐文件人工解决；未确定语义时停止并请求维护者，不要选 ours/theirs。 |
| script/ocgcore gitlink 不匹配 | 检查 `.gitmodules`、fork 上的提交和 `YGOPRO_*_COMMIT`；未确认 nested submodule 内容前不发布。 |
| CDB 无法打开、表缺失、增删改异常 | 停止并保留旧运行时；重新取得同一上游提交的 CDB，使用 `validate-cdb` 和 `compare-cdb`，不得直接覆盖。 |
| 先行卡 `.ypk` 被拒绝、列表 JSON 不合法或没有服务器 CDB | 保留旧 expansion 不变；检查 HTTPS 镜像、完整下载和官方包结构。不要绕过 ZIP/JSON 校验，也不要手动把客户端 `.ypk` 放入运行目录。 |
| expansion 与普通资源更新互相覆盖 | 标准更新默认启用 Super Pre 并以 Aly 已部署 manifest 计算差量；检查只删除此前受清单管理且官方包已移除的文件，未知文件保留。禁限表在独立 `banlist` 清单中更新，不受 `--skip-expansion` 影响。仅用户明确要求跳过 Super Pre 时传 `--skip-expansion`，并确认 expansion 删除清单为空。 |
| 先行卡 CDB 中的脚本或卡图缺失 | 核对 `.ypk` 的 `script/`、`pics/` 和两个 CDB 是否完整；确认目标宿主启用了 `LoadExpansions()`。不要把扩展卡并入主 `cards.cdb` 作为临时修复。 |
| manifest 已包含 expansion 但远端没有对应文件 | 检查是否在默认 `prepare` 后又用 `--skip-expansion` 部署；首次发布需在默认模式重新准备和发布。脚本会在上传前拒绝 manifest 与 payload 不一致的组合，保留远端旧状态。 |
| `missing-names.json` 有非衍生物 | `prepare --refresh-names`，按 exact code 修复；只对有编号和理由的少量例外使用 `--allow-missing-names`。 |
| 搜索出现 TYPE_TOKEN 衍生物或两个编号名称串用 | 检查 exact-code 映射和 token 类型过滤；不要用 alias/cid 合并记录。重新生成名称映射后再测试。 |
| 图片 HEAD/下载失败、ZIP 被拒绝、ETag 不一致 | 检查 HTTPS、网络代理和缓存摘要；可使用经过信任的 HTTPS 镜像重试。只清理对应损坏的 `.part`/归档，不关闭路径和大小校验。 |
| `vips`、premake、conda、编译库缺失 | 在兼容工具链补齐依赖后重跑；正式发布不能以 `--skip-images` 或忽略 `ldd` 代替。 |
| `ldd` 显示 `not found`（例如 libevent） | 在与 Aly ABI 兼容的构建环境补齐/重建依赖，并在本地和远端再次 `ldd`；不要把不匹配的系统库临时复制到生产目录。 |
| Windows 客户端过小、无法启动或无声 | 回到 `C:\projects\ygopro` 的正确 Cube 分支，确认 VS2022 Release、premake5、音频依赖和非 `--no-audio` 配置；通过 PE 依赖/启动测试后才替换。 |
| API/srvpro/E2E 测试失败 | 记录首个失败和 commit，先修复或回退本地变更；`--skip-e2e` 仅是临时诊断，不是发布通过。 |
| Aly SSH 锁、备份、integrity check 或 staging 预检失败 | 不切换 current，保留失败 release、日志和备份；解决远端问题后重新 deploy，不要手动删除旧资源。 |
| 发布后服务未 active、API/协议/AVIF 不通 | 先读取 systemd/journal 日志和 release metadata；若资源切换已发生，使用同一 `<release-id>` 执行 rollback。 |
| Next 静态 JS/CSS 404 或 MIME 为 HTML | 这是完整 Web 发布遗漏 `.next/static` 的典型问题；按 AGENTS.md 的 standalone 发布规则补齐静态目录并重启 Web，不能改 Nginx 把所有请求回退首页。 |
| 远端证书校验失败 | 使用正确的受信任 `YGOCUBE_ALY_URL`/证书链后重试；诊断可单独使用 `curl -k`，不要把跳过 TLS 验证写进正式脚本。 |
| 需要回滚 | 让维护窗口保持有效，运行 `bash scripts/update-card-resources.sh rollback --backup-id <release-id>`，再次完成两套健康检查。回滚恢复资源与配置；数据库缓存失效值可由 API 重建，比赛数据异常须另行核验备份后处理。 |

## 先行卡发布后补充验收

- 两套服务分别访问公网实际搜索路由和 `/pics/<code>.avif`，检查 MIME 和实体内容；
  页面 200、文件存在、staging 测试通过均不代表生产已生效。
- 用先行卡进入实际房间、准备并完成比赛；验证 BO3 换备和重连。独立 Duel 还需
  测试网页建房→原生客户端加入、原生建房→网页加入两个方向。
- 至少执行一个先行卡效果，覆盖召唤/发动、卡组选择、连锁处理/送墓等实际
  ocgcore 链路。全量元数据检查不等于逐一卡片效果实现均通过，应明确样例范围。
- 可用隔离探针：`EXPANSION_CODE=<code> STANDALONE_ONLY=1 STANDALONE_MATCH=1
  /usr/bin/node scripts/e2e/web-duel-smoke.cjs`；本轮 `EXPANSION_EFFECT=1` 使用
  固定的「优秀精灵」与装备卡夹具。测试必须在独立目录/数据库/房间执行。
- 若 WebSocket 反复连接，检查实际关闭码和 srvpro 日志。曾遇到代理统一使用
  loopback 后被全局 `BAD IP` 封禁；不要用关闭超时/取消所有协议检查来掩盖问题。
- Git 提交前检查根仓库和 submodule 的全部差异、运行时资源及敏感信息。
  已授权跨轮开发一起归档时可拆分提交；先推 fork 的特性分支再更新根 gitlink，
  不得把 srvpro/ygopro 推向 mycard 的 upstream origin。推送后核对远端 SHA。

## 最终验收标准

只有同时满足下列条件才报告“更新成功”：

1. **来源可追溯**：上游完整 SHA、script/ocgcore gitlink、CDB/图片/manifest 哈希
   和名称缺失报告齐全；版本号主版本与上游一致且保留 Cube 后缀。
2. **代码干净**：根 feature 分支和所有被修改的 submodule 工作区 clean；无运行时
   资源、原始图片、数据库、token 或临时状态被 Git 追踪；无冲突标记、无 force push。
3. **资源正确**：CDB SQLite integrity/代码集合通过；exact code 名称按完整 fallback
   选择；衍生物不出现在搜索/卡池；Lua 仅按 manifest 差量同步；AVIF 尺寸、MIME、
   数量和重复执行幂等性通过。标准更新必须验证当前官方 `.ypk`/列表、两个扩展 CDB、
   expansion 脚本/卡图清单和客户端元数据排除，并对照上次成功部署清单审计 expansion
   差量；只允许删除上次清单管理且已从当前官方包移除的文件。用户明确要求保留旧版时，
   才可跳过扩展更新，且 expansion 删除清单必须为空。
4. **本地构建测试通过**：helper、API、Web、srvpro、宿主 `ldd`/启动 smoke、E2E
   全部通过；Windows 客户端（若要求）为正确架构、可启动且音频依赖可用。
5. **Aly 运行正常**：备份的 Cube/独立 Duel SQLite integrity 为 `ok`；两套 API、
   srvpro、Web 与 Nginx 均 active；`/api/health`、首页、`/duel/decks`、静态资源、
   Cube `/api` 与独立 Duel `/duel-api` 新卡搜索、最新 OCG/TCG 禁限表、AVIF endpoint、
   srvpro HTTP/TCP/Cube 探针均通过；两套远端宿主 `ldd` 无 `not found`。
6. **可恢复且有记录**：release ID、备份目录、旧/新资源 hash、commit、测试结果和
   任何警告已保存；失败 staging 与备份在人工确认前不删除，必要时可用明确 backup ID
   回滚。


## Web 样式与本地卡图验收补充

- Next build 的启动目录会影响 Tailwind 的默认配置查找与 content 扫描。PostCSS
  必须显式定位应用的 Tailwind 配置，content 使用相对配置文件的路径；从仓库根目录
  构建也要跑测试。不得把“编译成功、CSS 200”当作完整样式生成的证明。
- 部署校验除 MIME 外，还要验证生成 CSS 含关键布局与主题工具类；真实浏览器检查
  grid 的 display、间距和主题颜色，并截图检查首页、后台、Duel、构筑页的桌面/手机布局。
- 本地图片测试需覆盖实际用户提供的编号/图片，损坏但非空的 JPG、可用 PNG 回退、
  根目录绑定以及刷新恢复。图片存在但不能解码时，继续尝试其他本地候选或服务器低清图。
- 真实外部目录和 OPFS 测试的权限行为不同；OPFS 通过不能证明用户原有授权仍有效。
  提供显式重新读取/更换目录入口，强制重新检查授权与刷新缓存，不要静默停留在坏图上。
