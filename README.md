# dsh-partition-board · 分区画板

AI 认为需要跟人确认「**怎么分区**」时自主调用的 DSH 插件。它在浏览器里弹出一块画板：

- 用**色卡控件**标注「颜色 ↔ 含义」（红=主区、蓝=侧栏…），颜色本身没有意义，图例才是语义；
- 人在画布上亲手**画出分区**：矩形 / 套索 / 软笔刷 / 橡皮，每块可调**边界羽化**（模糊分区）；
- **边画边写**：图形说不清的约束（「这块要能并排看两张卡」）可以直接写在右栏，随消息回传给 AI；
- **能放大细看**：Ctrl/⌘ + 滚轮以光标为锚点缩放（1–8 倍，普通滚轮仍然滚页面），「抓手」拖动平移，
  `0` 复位；装饰性线宽/字号/标签门槛都按缩放抵消，放大后不会糊；
- **未标注与细小分区由 AI 补全**，方案以虚线叠加展示，人点「确认」或「返工（附意见）」，
  反复到满意为止；
- 确认后的完整规划（图例 + 几何 + 羽化度 + 栅格矩阵）回传给 AI，AI 按 `purpose`
  解读并**据此推进项目**。

这块画板**不属于 UI**。界面区块、画面构图、文档分节、数据分段、图示分区——
只要一件事的本体是「在平面上划片」，它都适用。

## 让 AI 真的会用它

插件的可用性有一半不在画板上，而在**模型会不会想起它**。这一轮专门为此做了四件事，
并且是**量过**的（同一个模型、同一批 8 个场景，只换工具描述文本，让它写「第一个动作」）：

| 版本 | 该命中的 5 个场景 | 不该用的 2 个场景 |
| --- | --- | --- |
| A 早期描述 | 5/5 | 2/2 正确避开 |
| B 加了「正要写 3 行以上就停下」 | **3/5**（报告分节、API 文档结构掉成「我自己出大纲」） | 2/2 |
| C 现在这版 | **5/5** | 2/2 |

B 为什么变差：**阈值会被算**。写「超过 3 行才调」，模型就先算「这个不到 3 行」，
自己给自己开后门。所以现在分类条目是**无条件**的，另外加了一条挡后门的明文
（「别用『这个我自己写几行就能说清』把它挡掉」），并且这条写进了测试
（`tests/board.test.mjs` 里既断言关键词在，也断言阈值句**不**在）。

> 口径说明：单个评审、每版一次、8 个场景，而且评审看得到描述。真机上的绝对命中率会低
> 一些（工具清单里还有几十个工具抢注意力）。这张表能说明的是**相对**变化，以及那个
> 「阈值触发会被算成后门」的机制 —— 机制是可复现的，别只信这一个数字。

四件事：

1. **可识别的触发**：写用户真会说的话（「这样说不清」「画个图给我看」「我说不上来哪儿不对」），
   加上反例（别当是非题、别当成品展示）与成本承诺（不阻塞、调用很省）。
2. **第一次调用门槛降到最低**：只给 `purpose + task + ask` 也能立刻用 ——
   模型没给 `legend` 时画板先摆 4 个待命颜色，用户改个名字就能画；模型下一轮真给了色卡，
   待命颜色会被换掉而不是叠成两套。
3. **调用后的收益是确定的**：回传里有什么（`grid` 栅格矩阵、`stats`、几何、用户的 `note`）
   写在描述里，模型不用赌这次调用有没有用。
4. **技能里给「抓自己」的决策表**：左列是模型**正准备做的动作**（写长描述、连问空间问题、
   画 ASCII 布局图、猜一个版式），右列是更该做的事 —— 比分类名好认得多。

## 装法

```powershell
# 1) 目录联结（等价于 `dsh plugin --profile web add link:<dir>` 建的链接）
New-Item -ItemType Junction `
  -Path   "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-partition-board" `
  -Target "$env:USERPROFILE\.dsh\plugins\dsh-partition-board"

# 2) 在 ~/.dsh/profiles/web/package.json 里加两处：
#    dependencies:  "dsh-partition-board": "link:C:/Users/<你>/.dsh/plugins/dsh-partition-board"
#    dsh.profile.bundles: 追加 "dsh-partition-board"

# 3) 就绪。本机 DSH 0.1.6-alpha.2 实测：宿主会把新的 profile 行**热加载**——
#    工具与 skill 当场可用，已经打开的页面也会热接收到这个客户端 bundle。
#    不需要重启 dsh web，也不需要刷新页面。
#
#    保守做法（早期版本 / 热加载失效时）：重启 dsh web —— 客户端 bundle 是装载期发布的。
```

装之前先跑自检：

```powershell
cd "$env:USERPROFILE\.dsh\plugins\dsh-partition-board"
npm test          # 72 项：35 项纯函数 + 37 项无头渲染
npm run verify    # 8 项安装期契约自检
```

- `tests/board.test.mjs` —— 几何、栅格化、连通域体检、协议载荷、色卡/分区归一化。
  其中一条是**协议自洽性回归**：拿 `tests/fixtures/board-confirmed-2026-09-29.json`
  （用户亲手画并确认的那块板的原样捕获）里的矢量分区重跑一遍栅格器，
  要求它**逐格复现**画板当时发出来的矩阵。两边一对不上，就说明线格式与渲染/统计已经漂移。
- `tests/render.test.mjs` —— 自带一个最小 React（hooks / refs / 事件派发 / effect 清理），
  把画板组件真跑起来：拖鼠标画矩形与套索、在「边画边写」里打一段说明、点「让 AI 规划」、
  切 review 模式点确认/返工、派发一次 `ResizeObserver` 回调、Ctrl+滚轮缩放、抓手平移、
  读 `aria-*` 与英文文案，然后断言它**实际通过 `conversation.send` 发出去的那条消息**。
  其中两条是**版式回归守卫**：状态条必须在内容顶部通栏、动作区必须钉在控制栏底部
  —— 这个版式来自一块用户亲手画并确认过的画板（见下）。
  （本机 profile 里没有 react-dom，所以这一步是无头渲染而不是真浏览器截图。）

调试用解码器：`node scripts/decode.mjs <一条 [partition-board] 消息.json>`
把 `grid.cells` 还原成逐行 ASCII 分区图，算出每种颜色的格数与包围盒、未标注连通域，
并列出矢量分区。栅格按 z 序取最上层，所以它同时解决了「矢量里有重叠矩形」的歧义。

`verify.mjs` 会验掉几件「装完才发现就晚了」的事：补丁里的包名跟 `package.json`
是否一致、bundle 是否只用基线模块 `react`、**画板注册的 key 是否等于宿主工具名**
（写错的表现是工具能调、画板永远不弹）、skill 文件路径能否解析。

## 它为什么长这样（两条被源码否掉的路）

| 路线 | 结论 |
| --- | --- |
| 阻塞式：工具等用户在画板上画完 | **否**。客户端 → 宿主只有 `conversation.send()` 一条安全信道；复用现成的 `user-questions/request` 会被内置问题卡抢先应答（`ctx.remote.$on` 无优先级，注册顺序 = 插件加载顺序，内置在前）。而且阻塞**省不了回合**——AI 重新规划本来就需要一次模型回合。 |
| 纯客户端：本地算分区 | **否**。做不到「由 AI 自主规划」。 |
| 消息式（本实现） | **采用**。画板挂在 keyed slot `tool.call.toolview` 上，从工具参数的**实时流**（`block.argsRaw`）解析规格即可弹出；人的操作用一条 `[partition-board] {...}` 用户消息回传。 |

## 往返协议

```
模型调 partition_board({purpose, legend, ...})
        ↓  工具立即返回（不阻塞）
画板弹出，人标注 + 绘画 + 调羽化
        ↓  conversation.send("[partition-board] {...}")
模型收到 kind = plan-request | rework | confirmed
        ↓  前两者：同 boardId、revision+1、mode="review" 再调一次工具展示方案
        ↓  后者：拿到 plan，按 purpose 解读并推进
```

`boardId` + `revision` 是这套协议唯一的硬约束：`review` 模式漏传 `boardId` **会被工具直接拒绝**
（报错写清了怎么改），`draw` 模式漏传则是新开一块空画板；`revision` 递增后界面上更早的画板
自动折叠成一行摘要。用户「边画边写」的说明以顶层 `note` 随消息回传，与 `feedback`（返工意见）
分开——前者是「我画的是什么」，后者是「你的方案要改什么」。完整的协作规则写在
`skills/partition-board.md`（装的是一份 skill，不占常驻描述）。

## 文件结构

```
dsh-partition-board/
├── package.json          dsh.bundle.patch + dsh.client{platform:"web", inject:[]}
├── cordis.patch.yml      insert 一行 {id: partition-board, name: dsh-partition-board}
├── dsh.plugin.json       插件清单（inject: tools, skills）
├── lib/index.js          Host 半边：注册工具 partition_board + skill partition-board
├── client/client.js      浏览器半边：画板 UI（手写 bundle，只 require("react")）
├── skills/partition-board.md   教 AI 何时弹板、怎么读状态、按 purpose 怎么解读
├── tests/board.test.mjs  纯函数自测（几何 / 栅格 / 体检 / 载荷 / 归一化）
├── tests/render.test.mjs 无头渲染自测（最小 React + 事件派发 + 协议断言）
├── tests/harness.mjs     最小 React 渲染台（hooks / refs / canvas 桩）
├── scripts/decode.mjs    把一条画板消息解码成 ASCII 分区图 + 统计
└── scripts/verify.mjs    安装期契约自检
```

## 这块画板自己的版式是谁定的

2026-09-29：开机后第一次调用 `partition_board` 时，请用户顺手画了「你希望这个弹窗长什么样」。
用户画出四块并直接确认，栅格解码结果是：

```
 2 |··SSSSSSSSSSSSSSSSSSSSSSSSS·····|   S 状态条  通栏，横跨左右两列
 3 |··CCCCCCCCCCCCCCCCCCPPPPPPP·····|   C 画布    左列 72% 宽
 …
11 |··CCCCCCCCCCCCCCCCCCPPPPPPP·····|   P 控制栏  右列上半 75% 高
12 |··CCCCCCCCCCCCCCCCCCAAAAAAA·····|   A 动作区  右列下半 25% 高
14 |··CCCCCCCCCCCCCCCCCCAAAAAAA·····|
```

对照实现只差一处：状态条原本是画布下方的一行小字，已按图改成**内容顶部通栏**（带覆盖率进度）。
未标注的 43.6% 是一整块包住四周的连通域，读作页边距而不是漏掉的分区。

## 已知边界

- **画板状态存在 `localStorage`**（键 `dsh.partitionBoard.v1:<sessionId>:<boardId>`）。
  换浏览器 / 清缓存会丢；隐私模式下画板仍可用，只是不跨刷新记忆。
- **没有宿主侧的画板存储，这是刻意的**。第三方客户端插件在 DSH 0.1.6 拿不到浏览器会话的
  鉴权器：`BrowserAuth` 是 `dsh-client-connection` 里 `HostConnectionService` 的**私有字段**
  而不是 Cordis 服务，带 cookie 校验的 `/api` 路由也归它独占。插件能做的只是在 `webServer`
  上自建一条**没有 cookie 校验**的路由——那等于给本机开一个无鉴权端点，所以不做。
  需要跨浏览器留存时走安全路径：确认后让模型把 `plan` 写成 `<cwd>/.dsh/boards/<boardId>.json`。
- **宿主侧无状态**。工具只做校验与归一化回执，规划的事实来源是对话本身
  （工具参数 + `[partition-board]` 消息）。
- **栅格是 32 列**（行数按画布比例推），`grid.cells` 用 base36 单字符编码。
  这是给模型的空间摘要，不是像素级精度；精度在矢量几何里。
- **载荷有硬预算**：矢量总点数封顶 600（分区越多每块点越少），保证一条
  `[partition-board]` 消息不会把回合撑爆。分区不会因为超预算被丢掉。
- **全屏走 `shell.overlay` 全局槽**（root 作用域），不再用 `position:fixed` 自撑——
  否则聊天气泡里任何祖先带 `transform` 都会把「全屏」截在容器里。展开时工具行里那块
  换成一行占位，**同一时刻只有一个 BoardCore 实例**，避免两份 state 分叉。
- **多轮画板会堆叠**。每轮是一次工具调用，所以每轮都是一张卡；旧轮次自动折叠，
  点「仍要打开这一轮」只影响这一块板（不会把最新一轮挤下去）。
- **键盘快捷键只在拿到焦点的那块画板上生效**：Ctrl+Z 撤销 / Ctrl+Shift+Z / Ctrl+Y 重做 /
  Esc 取消当前绘制或退出全屏 / Delete 删掉选中分区 / `0` 视图复位。点过哪块板，焦点就在哪；
  新弹出来的画板默认夺焦。在输入框里打字不会触发。
- **画布跟随容器尺寸重画**（`ResizeObserver`）：改窗口大小、拉分栏、进出全屏都不会把笔迹
  按旧尺寸拉伸。显示器 `devicePixelRatio` 变化走同一套重绘。
- **缩放是「看的角度」不是画板内容**：按 boardId 记在内存里（内嵌 ↔ 全屏不丢，刷新即回 100%），
  不进 `localStorage`、不进回传载荷 —— 栅格统计与坐标始终是世界坐标，缩放只影响显示。
  「边画边写」那段说明同理：发送过的会随消息留下，没发的刷新即丢。
- **无障碍**：画布是 `role="application"` + `tabIndex=0`，`aria-label` 报「几个色卡、几块分区、
  覆盖率多少」，`aria-describedby` 指向 `role="status"` 的状态条（覆盖率与提示变化会被播报）；
  工具与色卡按钮带 `aria-pressed`，纯符号按钮（`×`/`+`/`−`）都有 `aria-label`。
- **双语**：界面文案按 `<html lang>` → `navigator.language` 选中/英（有信号但不是中文 → 英文；
  完全没信号 → 中文）。skill 与 README 不参与，它们是给模型和安装者看的。
- **还没做的**：触摸屏双指捏合/旋转（触控板捏合走 Ctrl+滚轮那条路已经能用）、
  分区布尔运算（挖洞/相减）、分区排序与图层调整。
