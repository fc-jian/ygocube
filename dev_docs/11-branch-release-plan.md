# 项目维护与实例数据

## 私有数据

每个实例独立管理 `CONFIG_FILE`、SQLite、卡库、卡图及可选的卡池初始化文件。Git 仓库保存应用、迁移、公开的官方参考数据和合成测试样例。真实房间、卡池成员、投票、凭据、部署地址、绝对安装路径与验收原件保存在实例或私有备份中。

配置中的 `server.pool_data_file` 可指向私有 JSON 文件。相对路径以配置文件所在目录为准。未设置时，API 在 SQLite 所在目录下查找 `private/pools.json`。省略此文件可从空实例启动，管理员仍可通过现有接口创建卡池。显式配置路径时，文件缺失或内容无效将中止启动。以下卡号仅供说明，部署时使用实例卡库中的有效卡号。

```json
{
  "version": 1,
  "draft": [
    { "name": "example-draft", "draftFormat": "edison_e3", "codes": [10001, 10001, 10002] }
  ],
  "guess": [
    { "key": "builtin:example", "name": "示例", "codes": [10001, 10002], "defaultPriority": 1, "browseOnly": false }
  ]
}
```

轮抽清单中每次出现代表一张实物卡。API 对每个名称只初始化一次，随后尊重管理员的编辑与删除。猜卡池按稳定的 `key` 识别，`defaultPriority` 值最高且已安装的池供默认选择，`browseOnly` 启用仅按卡名浏览。可用 `aliases` 保留旧显示名。只有私有清单显式提供完全匹配的 `previousCodes`（数组的数组）时才原地升级旧成员，当前无提示轮的候选会随原轮保存。已有房间、统计、运营调整均沿用 SQLite。

从早期版本升级时，先在实例内部制作 SQLite 一致性备份与私有清单。清单应使用该实例实际保存的成员、原名称和稳定键，写入原默认优先级和浏览方式。在隔离的数据库副本上比对卡池 ID、成员顺序和重复数、房间、历史事件与卡池行为，再切换应用。恢复实例时同时恢复业务库、配置及环境数据。

## 发布输入

在运维环境配置 `YGOCUBE_ALY_ROOT`、`YGODUEL_ALY_ROOT`、`YGOCUBE_ALY_URL` 和 SSH 连接信息。应用包由指定公开 Git 提交在 Linux 构建，分别使用 Cube 与独立 Duel 的 Web 路由配置。每套应用分别备份、核验活动房间、核对组件来源和静态资源。把源码提交、构建 ID 和验收记录保存在对应实例。CI 使用合成数据。

## 日常 Git 工作流

`main` 是 Cube 与独立 Duel 共用的集成分支。功能和修复使用短期 `codex/<task>` 分支，资源更新使用 `codex/card-resource-sync-<date>`。在仓库根目录运行以下命令，先用 `git status` 检查本人的未提交改动和子模块状态。

```bash
git fetch --no-tags origin
git switch main
git merge --ff-only origin/main
task=codex/example-change
git switch -c "$task"
```

1. 接口变更先更新 `dev_docs/07-protocol-api-design.md` 和共享契约，再更新调用方。涉及子模块时核对 `.gitmodules` 和子模块远端，先将 `ygopro` 的 `cube-server` 或 `srvpro` 的 `cube` 提交推到对应公开仓库，再提交根仓库记录的子模块 SHA。用 `git diff --submodule=log` 审阅指针变化。
2. 按路径暂存变更。提交前审阅 `git diff --cached`，推送前审阅 `git log -p origin/main..HEAD` 并检查提交消息、文件名和子模块指针。真实卡池成员、房间和玩家资料、密钥、部署地址、机器路径、运行截图及数据库备份仅进入实例的私有存储。测试夹具使用合成数据。可用 `git check-ignore -v -- config.yaml data/private/pools.json` 检查本地实例文件的忽略规则。
3. 在 `cube/` 运行 `pnpm install --frozen-lockfile`、`pnpm test` 和 `pnpm build`。仓库根目录的 Linux 脚本回归使用 `python3 -m unittest discover -s scripts -p 'test_*.py'`。Windows 的本地环境见[原生开发说明](10-windows-development.md)。
4. 显式推送本次分支，随后创建以 `main` 为基线的 PR。PR 写明功能、数据迁移影响和验证结果，使用公开样例。

```bash
git -c push.followTags=false push --recurse-submodules=check -u origin "HEAD:refs/heads/$task"
gh pr create --base main --head "$task"
```

### 合入与同步

`main` 启用分支保护，管理员也须经过 PR 和两项 GitHub Actions 检查。核对该 PR 的 `stack (ubuntu-latest)`、`stack (windows-latest)` 均为 `success`，并使用通过检查的 HEAD 创建 merge commit。若分支又有新提交，重新核验最新一轮检查。下例在发起 PR 的分支运行，`pr` 取该 PR 编号。

```bash
pr=$(gh pr view --json number --jq .number)
head=$(git rev-parse HEAD)
gh pr checks "$pr" --watch
gh pr merge "$pr" --merge --match-head-commit "$head"
git fetch --no-tags --prune origin
git switch main
git merge --ff-only origin/main
git merge-base --is-ancestor "$head" main
```

合并后在 `main` 核对两个父提交和相对发行版本的差异。需要留档时，给已审阅的公开提交打带说明的归档标签，然后用 `git branch -d` 清理已合入的本地任务分支。删除远端分支、发布标签和部署是三个独立操作。

## 两套应用的发布与标签

| 阶段 | 操作和验收依据 |
| --- | --- |
| 选择源码 | 用通过 PR 的完整 merge SHA 在干净的 Linux 检出中构建，记录根提交和两个子模块 SHA。构建机与服务主机的 Node 原生模块 ABI、架构及系统库要兼容。 |
| 构建应用 | 两个 Web 分别使用自己的 API 基址和静态前缀。把对应的 standalone、`.next/static` 和存在的 `public` 一起打包。API 依赖以该提交的 `cube/pnpm-lock.yaml` 为准。执行冻结安装后，可在 `cube/` 用 `pnpm --filter @ygocube/api deploy --legacy --prod <暂存目录>` 输出运行依赖。两个工作区包使用同一提交的编译产物，并在隔离目录验证 SQLite 原生模块可加载。 |
| 校验候选 | 在 Linux 使用冻结锁文件安装依赖、构建两份 Web，再运行 `python3 scripts/package-app-release.py <构建目录> <包路径> <源码SHA> main <srvpro SHA>`。打包器从工作区锁文件派生专用部署锁，以 pnpm 的 hoisted 布局安装生产依赖，工作区包随成品落盘，并在打包目录运行 Node 和 SQLite 验证。格式 2 包含完整生产 API 依赖、静态资源、文件哈希与链接清单。stage 及激活时按包的 SHA-256、发布模式、Web build ID 和文件清单核对候选，并用服务器 Node 打开内存 SQLite。重复编号只能使用原包；新的构建使用新的发布编号。 |
| 数据与切换 | 每套实例分别备份 SQLite、配置、私有清单及上一版指针，用自身数据库副本预演迁移。检查比赛、小游戏和宿主的活动状态。预演通过后在维护窗口切换该实例的 `current`。 |
| 线上验收 | Cube 验证公网 `/api/health`、轮抽和卡池。独立 Duel 在实例内验证 `/health`，公网验证 `/duel-api/public/duel/options`、大厅和卡组。两套 Web 都检查引用到的 JS/CSS 的状态码和 MIME。比对已存业务记录、数据库完整性和组件来源。完整的 SHA、build ID、包校验和、备份位置与回滚验证留在各实例的私有回执。 |

每套应用验收通过后给它的实际源码提交打独立的 annotated tag，命名为 `release/aly/cube/YYYYMMDD-<short-sha>` 或 `release/aly/duel/YYYYMMDD-<short-sha>`。两个实例可以指向同一提交。标签消息只写应用和源码版本。更晚的文档提交可以合入 `main`，线上标签继续标识实际运行的源码。只有实例数据变化时，数据版本记入实例私有记录。

```bash
# 变量 source、app、date_ymd 取自本次验收，app 为 cube 或 duel。
short=$(git rev-parse --short=7 "$source")
tag="release/aly/$app/$date_ymd-$short"
git tag -a "$tag" "$source" -m "Deploy $app API and Web at $short"
git -c push.followTags=false push origin "refs/tags/$tag:refs/tags/$tag"
git ls-remote --tags origin "refs/tags/$tag" "refs/tags/$tag^{}"
```

核对远端标签的 `^{}` 对象为验收记录中的完整提交。回滚时按该实例的私有回执选择上一版，核实数据库兼容性，复验同一组接口、静态资源和业务记录。恢复数据库前须单独确认如何处理备份之后产生的数据。

## 历史清理后的旧副本

日常开发从当前公开 `origin/main` 建分支。旧私有备份在独立目录恢复，个别修复经过逐项审阅后移植到新分支。推送只引用明确的公开分支或标签，尤其在保留私有历史的旧克隆中避免 `--all`、`--tags` 和 `--mirror`。

发现误传时，先私有备份并验证可恢复性，再列出受影响的分支、标签、旧对象 ID 及平台引用。对照清单单独确认历史重写与删除，用每个引用的精确旧 SHA 保护操作，完成后核查远端引用和分支保护。旧 PR、Actions 记录、平台缓存和第三方克隆须逐项处理。已泄露的有效凭据应在实例端轮换。[GitHub 敏感数据清理说明](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)
