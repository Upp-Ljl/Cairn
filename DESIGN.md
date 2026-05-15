# Design System — Cairn

> 这份文档是 Cairn UI 的 single source of truth。任何视觉 / UI 决策（颜色、字体、间距、动效、组件样式）以此为准。改这份文档前先和用户对齐。

## Memorable anchor

**"一眼看清所有状态，给跑 agent 的人用，不是给经理用的"**

每个设计决策都服务于这句话。信息密度高但层级清晰；工程师审美不是管理者审美。

## Product context

- **What this is:** Cairn 是 project control surface，多 agent 编程项目的本机桌面侧边窗 / tray / ambient marker / live run log
- **Who it's for:** 写代码的人，长程跑多个 agent / subagent，需要看清状态、复盘、接力、回退
- **Project type:** Electron 桌面应用，侧边面板形态（320–520px 宽），单列布局，read-only
- **Reference aesthetics:** Linear（信息密度 + accent 极简）、Raycast（暗色 surface 层级）、Activity Monitor / journalctl（系统监控感）

## Aesthetic direction

- **Direction:** Industrial / Utilitarian
- **Decoration level:** Minimal — 字体做所有工作，1px solid 边框，几乎不用阴影（浅色模式例外）
- **Mood:** 像航空管制台 / 监控终端，不是 Figma 设计稿
- **Principle:** 减少视觉噪音（去大色块、降圆角、压间距），让信息层级用字重 + 一个 accent 自然浮现

## Color

**核心原则：颜色越少越好。** 信息靠位置、字重、opacity 传达。颜色只做两件事：标识活跃 / 交互（accent 蓝）+ 提示需要人干预（alert 红）。其余全用灰阶。

### Dark theme (default)

```css
/* Backgrounds — 3 层灰阶 */
--bg-base:      #0f0f0f;   /* 底层 */
--bg-surface:   #161618;   /* 卡片 / 模块 */
--bg-elevated:  #1e1e22;   /* hover / 弹出层 */

/* Borders */
--border:       #2a2a2e;
--border-focus: #3a3a40;   /* hover / focus 状态 */

/* Text — 3 级 */
--text-primary:   #e8e8ec;
--text-secondary: #8888a0;
--text-muted:     #555566;

/* Accent — 活跃 / 交互 */
--accent:       #5b9aff;
--accent-muted: #3d6ab3;
--accent-bg:    rgba(91, 154, 255, 0.08);

/* Alert — 仅"需要你干预" */
--alert:        #e85545;
--alert-bg:     rgba(232, 85, 69, 0.08);
```

### Light theme (system-style)

参考 macOS / Windows 11 系统应用，不是简单反色。卡片用微妙 box-shadow 代替硬边框。

```css
--bg-base:      #f0f0f3;
--bg-surface:   #fafafa;
--bg-elevated:  #ffffff;
--border:       #e2e2e8;
--border-focus: #c8c8d2;

--text-primary:   #1c1c22;
--text-secondary: #55556a;
--text-muted:     #8e8ea0;

--accent:       #2e6ed8;
--accent-muted: #6a9be6;
--accent-bg:    rgba(46, 110, 216, 0.07);

--alert:        #c42828;
--alert-bg:     rgba(196, 40, 40, 0.05);

--shadow: 0 1px 3px rgba(0,0,0,0.06), 0 0 0 1px rgba(0,0,0,0.03);
```

### Color usage rules

| 场景 | 用色 |
|---|---|
| 活跃 agent / 进度 / 当前 task / Mode A plan 当前步骤 | `--accent` |
| 交互元素（按钮 hover、tab active、链接） | `--accent` |
| 真正需要人干预（NEEDS YOU 模块、blocker、stale agent） | `--alert` |
| 主要文字 | `--text-primary` |
| 次要文字 / metadata / 完成状态 | `--text-secondary` |
| 时间戳 / hint / 灰掉的 done 项 | `--text-muted` |
| 所有"状态徽章"（RUNNING / WAITING / DONE） | 灰底 + accent / muted 文字。**不用绿/琥珀/紫** |

**禁用：** 绿色（成功）、琥珀色（警告）、紫色（review）作为独立状态色。这些状态用 opacity / 字重 / 位置区分，不靠颜色。

## Typography

**唯一字体：** JetBrains Mono（主力），fallback 到 `ui-monospace, Cascadia Mono, Menlo, Consolas, monospace`。

不引入比例字体。层级用**字重 + 字号 + opacity** 区分，不用颜色。

```css
--font: 'JetBrains Mono', ui-monospace, 'Cascadia Mono', Menlo, Consolas, monospace;

/* 字号谱 */
--text-xs:   10px;   /* 时间戳 / 来源标签 / 小 badge */
--text-sm:   11px;   /* 次级信息 / metadata */
--text-base: 12px;   /* 主体文字 */
--text-md:   13px;   /* 模块标题 */
--text-lg:   15px;   /* 页面标题 / header */
--text-xl:   18px;   /* 数字（进度百分比） */
```

**字重约定：**
- `400`：正文
- `500`：tabs / 状态标签 / 进度数字
- `600`：模块标题（uppercase）/ accent 强调 / 数字

**模块标题样式：**
```css
.module-title {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
```

## Spacing

Base unit **4px**，compact 密度（信息密集型）。

```css
--sp-2xs: 2px;
--sp-xs:  4px;
--sp-sm:  8px;
--sp-md:  12px;   /* 模块内 padding */
--sp-lg:  16px;
--sp-xl:  24px;
--sp-2xl: 32px;
--sp-3xl: 48px;
```

**布局规则：**
- 单列面板宽 320–520px
- 模块间用 1px `border-bottom` 分隔，**不用大段空白**
- 模块内 padding 12px
- 行间距 4–6px

## Border radius

偏小，工业感。不用 12px+ 的圆角。

```css
--radius-sm: 4px;   /* badge / 小按钮 / checkbox */
--radius-md: 6px;   /* 卡片 / 输入框 */
--radius-lg: 8px;   /* 弹出层 / 设置面板 */
```

## Layout

- **结构：** 顶部 header（32px）→ tabs → mode bar → 状态条 → 当前 task → 多个模块 → footer
- **模块识别：** 左侧 3px 色条（accent / alert / muted）+ 模块标题 uppercase
- **NEEDS YOU 例外：** 模块左侧色条用 `--alert` 并加发光动效，引起注意

## Motion

**原则：快且轻，只做有意义的动效。** 不为装饰加动画。

### Tokens

```css
--ease-out:    cubic-bezier(0.16, 1, 0.3, 1);
--ease-in:     cubic-bezier(0.7, 0, 0.84, 0);
--ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);

--dur-micro:  80ms;    /* hover 颜色变化 */
--dur-short:  150ms;   /* 按钮状态 / badge */
--dur-medium: 250ms;   /* 视图切换 / 卡片展开 */
--dur-long:   400ms;   /* 进度条增长 / 主题切换 */
```

### Effective motion list

每个动效都对应一个具体的信息传达：

| 动效 | 用途 |
|---|---|
| **状态点呼吸脉冲** | 标识"活跃中"——只在 active session / 运行中 task 上 |
| **NEEDS YOU 色条发光呼吸** | 真正紧急时吸引注意力——仅 alert 模块 |
| **进度条 shimmer + 从 0 展开** | 标识"实时进行中"——不是静态指标 |
| **视图切换 fade + translateY(6px)** | 确认切换发生了——Mode A ↔ B / project 切换 |
| **Activity feed 列表 stagger 入场** | 新事件感知——每条延迟 40ms 入场 |
| **行 hover 微亮背景** | 可交互反馈——todo / checkpoint / session 行 |
| **Go 按钮 hover 微光填充** | 确认可点——半透明叠加，不强调 |
| **主题切换平滑过渡** | 不闪——所有 panel 元素背景 / 边框 / 文字 250ms |

**禁用：** 弹跳、回弹、旋转、装饰性的 fade-loop、3D 翻转。

## Components

### Status dot

```css
.dot { width: 8px; height: 8px; border-radius: 50%; }
.dot.active {
  background: var(--accent);
  box-shadow: 0 0 6px var(--accent);
  animation: dotPulse 2s ease-in-out infinite;
}
.dot.alert {
  background: var(--alert);
  box-shadow: 0 0 6px var(--alert);
}
```

### Tag / Badge

```css
.tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  font-weight: 500;
}
.tag-accent { background: var(--accent-bg); color: var(--accent); }
.tag-alert  { background: var(--alert-bg);  color: var(--alert); }
.tag-muted  { background: var(--bg-elevated); color: var(--text-secondary); }
```

### Button (ghost)

```css
.ghost-btn {
  font-size: 11px;
  padding: 2px 8px;
  border: 1px solid var(--border);
  background: none;
  color: var(--text-secondary);
  border-radius: 4px;
  transition: all 150ms var(--ease-out);
}
.ghost-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-bg);
}
```

### Module with left stripe

```css
.module { border-bottom: 1px solid var(--border); position: relative; }
.module-stripe { position: absolute; left: 0; top: 0; bottom: 0; width: 3px; }
.module-stripe.accent { background: var(--accent); }
.module-stripe.alert  { background: var(--alert);
  box-shadow: 2px 0 8px var(--alert);
  animation: stripeGlow 2s ease-in-out infinite;
}
.module-stripe.muted  { background: var(--border-focus); }
.module-inner { padding: 12px 12px 12px 18px; }
```

### Progress bar

```css
.progress-wrap { height: 4px; background: var(--bg-elevated); border-radius: 2px; overflow: hidden; }
.progress-bar {
  height: 100%;
  background: linear-gradient(90deg, var(--accent), var(--accent-muted));
  border-radius: 2px;
  transition: width 400ms var(--ease-out);
  animation: progressGrow 800ms var(--ease-out) forwards;
  position: relative;
}
.progress-bar::after {
  content: '';
  position: absolute; inset: 0;
  background: linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.15) 50%, transparent 100%);
  animation: shimmer 2s ease-in-out infinite;
}
```

### Todo / NEXT UP row

统一一条 row：左文字 + 右来源标签（灰色小字）+ `Go →` 按钮一键派单。不分 `mentor_todo` / `agent_proposal` / `user_todo` 三种交互——视觉上是一个待办列表，来源仅作次要灰色标注。

```html
<div class="todo-row">
  <span class="todo-text">Auth token expiry edge case — add refresh</span>
  <span class="todo-source">mentor</span>   <!-- 灰色 9px -->
  <button class="ghost-btn go-btn">Go →</button>
</div>
```

## Anti-patterns（已踩过的坑）

- ❌ **多种状态色（绿/琥/红/紫）并存**：视觉噪音，信息层级被颜色干扰。改用 accent + alert + 灰阶
- ❌ **整块色背景**（暗红 NEEDS YOU 块、暗绿 ACTIVE 块）：竞品都不用，让 panel 看着像告警弹窗。改用左侧 3px 色条
- ❌ **三种 todo 来源各一种按钮文案**（Approve→ / 派给 ▾）：用户不关心来源差异，最终行为都是派单。统一成 `Go →`
- ❌ **大段空白**（模块间 24px+ gap）：信息密度产品不该这样。模块间 1px border-bottom + 12px padding
- ❌ **装饰性动效**（fade-loop / 旋转 / 弹跳）：每个动效要对应一个信息传达

## Decisions log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-05-15 | 初始 DESIGN.md 创建 | `/design-consultation` 后的输出。竞品研究：Linear / Raycast / Warp / Zed |
| 2026-05-15 | Color palette 从 5 色（accent + 4 status）压缩到 2 色（accent + alert） | 用户反馈"颜色太多看不清信息"。简化后视觉噪音大幅降低 |
| 2026-05-15 | Mode B Todolist 三来源统一成"NEXT UP"单一列表 + `Go →` 一键派单 | 用户质疑"为什么 mentor 建议和 agent 委派不是同一件事"。理想状态：approve = dispatch |
| 2026-05-15 | 浅色主题用 box-shadow 代替硬边框 | 用户要求"系统风格"——参考 macOS / Windows 11 原生应用 |

## Preview

预览页：`packages/desktop-shell/dev/design-preview.html`（启动 `node packages/desktop-shell/dev/serve.mjs` 后访问 `http://localhost:3210/dev/design-preview.html`）

可切 Dark/Light 主题 + Mode A/B 视图四种组合。
