# UI 与交互

## 风格与布局

- 延续深色桌布绿、细边框、浅字和暖金色主操作。全站已有 `--yc-ink`、`--yc-felt`、`--yc-gold` 等变量和 `.yc-panel`、`.yc-primary`、`.yc-secondary` 等样式。游戏自己的场地布局与控件样式由路由布局加载，在游戏根元素或类名前缀下限定作用范围。[全局样式](../../../../cube/apps/web/app/globals.css) · [Guess 样式](../../../../cube/apps/web/app/games/guess/guess.css)
- 复用 Guess 顶栏的组织方式，保留回 YGO Cube、回大厅和对应工具入口。首屏直接放建房、加入、卡池选择或当前行动。简短文案用于说明状态、可执行操作和失败原因。避免占用游戏区的宣传标题和重复说明。[Guess 顶栏](../../../../cube/apps/web/components/guess/GuessFrame.tsx) · [大厅](../../../../cube/apps/web/components/guess/GuessLobby.tsx)
- Guess 在宽屏将牌桌与排名放左侧，行动与候选检索放右侧，窄屏上下排列。座位在 8 人及以下沿圆桌排布，9 人起使用网格。这个分界只用于布局。新玩法按实际支持人数设计布局，核查小屏、长玩家名和长卡名，确保筛选展开后结果和操作仍可到达。[房间](../../../../cube/apps/web/components/guess/GuessRoom.tsx) · [Guess 样式](../../../../cube/apps/web/app/games/guess/guess.css)
- UI 字符串采用中英双语。Guess 默认中文，语言选择保存在本地。房间阶段、错误、提示方法与分组用稳定键，按语言映射文字。数值提示用包含端点的描述，尽量用「以上」「以下」，区间需写清上下界。[Guess 文案](../../../../cube/apps/web/components/guess/guess-text.ts)

## 操作与卡片

- 当前行动、已选、猜错、禁用和结算用文字或语义标记表达，颜色用于辅助辨认。按钮保留键盘焦点和可读的名称。初始提示可悬停或点击查看详细说明。卡名和卡图支持悬停预览，点击或用键盘可固定详情，触屏也能查看。[提示按钮](../../../../cube/apps/web/components/guess/GuessHintButton.tsx) · [猜测卡名](../../../../cube/apps/web/components/guess/GuessCardName.tsx)
- 卡图复用 `CardImage`，可交互卡片用 `CardWithTooltip`，详情由根布局挂载的 `CardPreviewHost` 展示。卡面使用共享比例、按需加载与回退。卡片详情复用 `CardMeta` 的类型、数值、字段、首发年份等显示。猜测历史只有编号和名字时，可沿用 `GuessCardName` 按需读取详情。未公开的手牌渲染卡背，无需向浏览器传输牌号或图片请求。[卡图组件](../../../../cube/apps/web/components/CardImage.tsx) · [卡片详情](../../../../cube/apps/web/components/CardPreview.tsx) · [根布局](../../../../cube/apps/web/app/layout.tsx)
- 卡池、局内和 Duel 构筑共用 `CardSearchFields` 与 `CardSubtypeEditor`。搜索结果展示筛后张数和页数，改查询或筛选后从第一页开始。范围栏统一显示「等级／阶级／连接值」，连接方向用箭头按钮。局内猜错的牌留在列表里，标记「已猜过」并禁用选择。[筛选控件](../../../../cube/apps/web/components/CardSearchFields.tsx) · [Guess 搜索](../../../../cube/apps/web/components/guess/GuessCards.tsx)
- 子类型用关键词补全生成标签。括号、「非」「与」「或」也是标签，点击已有标签直接删除。沿用卡框色，通常黄、效果橙、仪式蓝、融合紫、同调白、超量黑、灵摆淡绿、连接淡蓝、魔法绿、陷阱红，逻辑标签为中性灰。标签仍显示文字。[子类型编辑器](../../../../cube/apps/web/components/CardSubtypeEditor.tsx)
