# 卡牌异画、卡图加载与浏览器查找

## 名称与身份

依据 `ygopro/gframe/data_manager.cpp` 的原生规则，将非零且非自身 alias、编号差绝对值小于 20 的卡识别为异画；5405695 保持原生规则同名特例。API 增加可选 `aliasKind`，详情分别显示“异画版本”与“规则同名”。

名称依次使用 exact code 的外部映射、异画原版 alias 的外部映射、exact code 的 CDB 原名。规则同名卡不继承目标名称。异画继承原版搜索别名，但编号、图片、效果、卡池身份、抓位仍按 exact code 保留；卡组副本上限和禁限规则不变。

## 加载与 Ctrl+F

共享 CardImage 使用一个 IntersectionObserver，进入视口附近 240px 才读取本地图或请求远程图片，覆盖卡池、候选池、搜索和构筑页。图片占位保留尺寸，避免滚动时布局跳变。

每张卡片保留一段位于图片下层的透明卡名与八位编号文本。文本不使用 display:none 或 visibility:hidden，也不采用移除离屏卡片 DOM 的虚拟列表，因此浏览器查找可定位未加载图片的卡片，滚动后再加载图片。查找范围为页面已渲染的卡片，不能搜索服务器上尚未返回的结果。

## 回归

- Windows/Linux：API 213 项、Web 31 项通过；Linux 协议 31 项及生产构建通过。
- `scripts/e2e/card-lazy-browser.cjs`：750 张卡的初屏请求数，桌面 90、手机 45；浏览器 Find 可定位第 750 张卡并触发加载；滚动继续加载；无横向溢出。
- `scripts/e2e/card-details-browser.cjs`：规则同名/异画两类分别在 1440/390 像素验证，含禁限表、详情、保存及弹窗。
- `scripts/e2e/deck-drag-browser.cjs`：拖动、移出副卡组、旧响应乱序与取消清理回归。
