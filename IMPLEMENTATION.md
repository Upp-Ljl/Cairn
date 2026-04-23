# Cairn 工程实现文档 v0.0.1 Preview

> 版本：v0.0.1 Preview 实施版 · 方法级 + 代码级工程规格书
> 日期：2026-04-22
> 目标读者：即将开工的 Cairn 工程师
> 文档定位：定位书（`C:\Users\jushi\.claude\plans\agent-gitbutler-b-partitioned-feather.md`）→ 本文档 → 代码
> 有冲突时，定位书为准；本文档是定位书在 v0.0.1 Preview 范围内的工程落地细化，**不扩大 scope，不涵盖 v0.1 MVP**。
> 本文档是**唯一指导文件**——工程师照着每一节每一个方法写代码即可，不需要再去推断。

---

## 目录

- §1 总览（范围、目标、非目标、技术栈）
- §2 系统架构（数据流、请求生命周期时序图）
- §3 Lane Attribution 实现（Layer 1/2/3 叠加 + 降级）
- §4 Classification 实现（manifest-only + L3 gate）
- §5 Compensator Engine 实现（五件套 + 状态机）
- §6 存储层（SQLite schema + CheckpointSaver 接口实现）
- §7 Mode 配置（strict / acceptIrreversible / bypass）
- §8 CLI 契约（10 个命令的方法级实现）
- §9 MCP 工具契约（6 个工具的 schema 冻结）
- §10 GitHub Adapter Manifest（加载器 + 8 端点 YAML）
- §11 3 周工程计划（Day 级）
- §12 测试策略（Unit / Fault / E2E）
- §13 开源分发
- 附录 A：关键 TypeScript 类型（≥ 15 个）
- 附录 B：GitHub Manifest YAML 完整 + 本地 adapter 模板
- 附录 C：3 轮 POC 复现命令与关键数据

---

## v0.0.1-r1 Revision Log

本修订版（r1）修复了首版工程评审暴露的 6 个 findings，不改变章节骨架，仅在章节内部深化或新增子节。

| # | 等级 | 修复摘要 | 落点章节 |
|---|---|---|---|
| 1 | P0 | **HTTPS MITM 悖论**——Preview 采用"双轨"策略：默认 local mock GitHub server（§10.4），opt-in MITM 作为 stretch goal（§13.4）；§3 加前置声明 Preview 示例假设 HTTP 明文 | §2.3 · §3 · §10.4 · §11 · §13.4 |
| 2 | P1 | **Compensation 模板变量无解析机制**——统一 `${namespace.path}` 语法，新增 `TemplateResolver` 类 + `ResolutionContext` 契约，执行前两次绑定；manifest 全部切换为新语法 | §4.4 · §5.3 · §10 manifest · 附录 A |
| 3 | P1 | **`classifierResultCache` 无持久化**——`ops` 表新增 `classifier_result_json`；row mapper 恢复；`gatherIrreversibleTail()` 改用持久化字段；加 "Restart Durability 契约" | §5.1 · §6.1 · §6.5 |
| 4 | P1 | **事务 + 并发锁不足**——`withTx()` 明确 sync / async 两种模型；`tryAcquireLaneLock()` 改为原子 `UPDATE` CAS（lanes 表新增 lock_holder / lock_expires_at 字段）；加"并发与事务模型约定" | §6.1 · §6.3 · §6.6 |
| 5 | P2 | **strict approval gate 连接语义不工程化**——定义超时 / 断连 / 重放规则；`ops` 表新增 `request_snapshot_json`；`RequestSnapshot` type；CLI approve/deny 行为明确化 | §7.3 · §6.1 · §8.5 · 附录 A |
| 6 | P2 | **labels optimistic lock 不一致**——manifest label 条目加 `field-match` spec 完整体；compensator 新增 `executeFieldMatch` 分支；`verifyOptLockResponse()` 按 spec.type 走分支；新增 OptLockSpec 族 types | §5.3 · §10.3 · 附录 A |

所有修改均保持向后兼容 Preview 写作风格；示例代码与定位书决策一致。

---

## v0.0.1-r2 Revision Log

本修订版（r2）由 98 条 test suite 生成过程暴露的 4 处 interface ↔ 叙事不一致修复。接口层（附录 A）是真源，叙事与之对齐。

| # | 等级 | 修复摘要 | 落点章节 |
|---|---|---|---|
| 1 | P2 | **`laneStateToExitCode` 两层映射**——engine 只产出 receipt；CLI 层决定 exit code：`failed.length === 0` 走 `laneStateToExitCode(0/2/4/5)`，否则 `failed[0].code` 映射（仅此路径产出 exit code 3）；新增 `deriveProcessExitCode()` helper 统一入口 | §5.5 |
| 2 | P2 | **Receipt 无 `haltedAt` 字段**——全文移除 `haltedAt` 引用；中断位置由 `failed[0].stepIdx` 提供；Receipt 定义加不变量注释明确 | §5.6 · 附录 A |
| 3 | P2 | **Receipt 无 string `status` 字段**——`exitCode: 0|2|3|4|5` 是唯一真源；新增 `exitCodeToString()` helper 供展示层使用；禁止在 Receipt 加冗余 `status` 字段 | §5.5 · 附录 A |
| 4 | P2 | **Receipt 加 denormalized agent 上下文**——Receipt 新增 `agentId` / `agentName` / `pipelineId` / `engineVersion` / `generatedAt` 字段，让 receipt self-contained；`buildReceipt(lane, ctx, plan)` 接收完整 Lane 而非只有 laneId | §5.6 · 附录 A |

r2 核心原则：**Receipt 的接口层（附录 A）是 single source of truth**；叙事、code 示例、CLI 输出全部与之对齐。test suite 中 `DEFER-001 ~ DEFER-006` 明确标记的文档未定义点不在本次修复范围。

---

## 1. 总览

**Cairn 一句话**：agent 的安全网——外部调用自动 record / classify / revert，出错能撤、撤不了的诚实标注。

**v0.0.1 Preview 范围**（2-3 周）：用一个真实外部目标（GitHub sandbox repo）跑通完整的 `record → classify → revert` 闭环，**带完整五件套 compensator engine + 3 个 fault injection 场景进 CI**。Preview 是 v0.1 MVP 之前的抢跑版本——**不是 demo toy**，五件套的代码直接被 v0.1 复用。

**明确不做（延到 v0.1+）**：
- MCP proxy（Preview 仅 HTTP forward proxy）
- HTTPS MITM（用户手工配 TLS CA 作为 known issue 公开）
- Web UI（仅 CLI）
- 除 GitHub 外的任何 target（Postgres / Stripe / Slack 全部延后）
- LLM fallback classifier / 规则引擎（Preview 只做 L0 manifest）
- 非 Claude Code 框架集成

**技术栈**：
- **Bun + TypeScript**：Bun runtime 自带 `fetch` / sqlite / HTTP server / test runner，零依赖起步；TS 用于类型化的 manifest 和 receipt 契约
- **SQLite**（`bun:sqlite`）：单文件、原子写、零配置；`~/.cairn/timeline.sqlite`
- **YAML** 存 manifest：`manifests/github.yaml`，`js-yaml` 解析
- **Bun test**：跑 unit + fault injection；CI 用 GitHub Actions
- **ulid**：lane_id / op_id 生成（`ulid` npm 包或 Bun 内置 crypto.randomUUID 做 base32）

**仓库结构**：

```
cairn/
├── package.json              # bun workspace root
├── tsconfig.json
├── src/
│   ├── cli/                  # cairn <cmd> 入口 (commander)
│   │   ├── index.ts          # argv dispatch
│   │   ├── start.ts          # cmdStart
│   │   ├── stop.ts           # cmdStop
│   │   ├── status.ts
│   │   ├── init.ts
│   │   ├── lanes.ts
│   │   ├── show.ts
│   │   ├── tail.ts
│   │   ├── revert.ts
│   │   ├── approve.ts
│   │   └── deny.ts
│   ├── proxy/                # HTTP forward proxy (7778)
│   │   ├── server.ts         # Bun.serve + CONNECT tunnel
│   │   └── forwarder.ts      # 上游转发 + header stripping
│   ├── recorder/             # lane & op 落盘
│   │   └── recorder.ts
│   ├── classifier/           # manifest loader + 分类决策
│   │   ├── classify.ts
│   │   ├── manifest.ts       # ManifestRegistry
│   │   └── path-match.ts     # RFC 6570 style 占位符匹配
│   ├── reverter/             # 五件套 compensator engine
│   │   ├── engine.ts         # CompensatorEngine
│   │   ├── invariant.ts
│   │   ├── optlock.ts
│   │   ├── idempotency.ts
│   │   ├── state-machine.ts  # 两级状态机转移函数
│   │   ├── receipt.ts        # Receipt 构造
│   │   └── before-image.ts
│   ├── storage/              # CheckpointSaver 接口 + SQLite 实现
│   │   ├── saver.ts          # interface
│   │   ├── sqlite-saver.ts   # SqliteCheckpointSaver
│   │   └── schema.sql
│   ├── attribution/          # Layer 1/2/3 lane 归属
│   │   ├── resolver.ts       # LaneResolver
│   │   ├── inline-mcp.ts     # Layer 1
│   │   ├── hook-socket.ts    # Layer 2
│   │   └── pid-lookup.ts     # Layer 3
│   ├── mode/                 # 模式配置合并
│   │   └── mode.ts
│   └── types.ts              # 全局 TS 类型
├── manifests/
│   └── github.yaml           # 8 端点 manifest
├── tests/
│   ├── unit/
│   ├── fault/                # F-invariant / F-optlock / F-midstep
│   └── e2e/
├── demo/
│   ├── run-demo.sh
│   └── screencast-script.md
├── .github/workflows/ci.yml
├── README.md
├── IMPLEMENTATION.md         # 本文档
└── LICENSE                   # Apache 2.0
```

**已知风险 + 应对**
- Bun 在 Windows 下 sqlite native binding 曾有 issue，Week 1 Day 5 预留 half-day 切 `better-sqlite3`
- Preview 范围收得很紧，任何"顺便加一下"的新 target / 新 adapter 请求都 defer 到 v0.1

---

## 2. 系统架构

Preview 架构相比 README 里的 full vision 简化版——**MCP proxy 暂不启用，所有 agent 出站走 HTTP proxy**。

```
                              [ Claude Code Orchestrator ]
                                         │
               ┌─────spawn────────────────┼────────────spawn────┐
               ▼                          ▼                     ▼
        [ Subagent A ]             [ Subagent B ]         [ Subagent C ]
        (frontmatter 注入           (frontmatter 注入      (frontmatter 注入
         HTTP_PROXY + lane-id)       HTTP_PROXY + lane-id) HTTP_PROXY + lane-id)
               │                          │                     │
               └──────── HTTP CONNECT/forward ──────────────────┘
                                         │
                                         ▼  localhost:7778
              ╔═══════════════════════════════════════════╗
              ║                  C A I R N  v0.0.1        ║
              ║  ┌─────────────────────────────────────┐  ║
              ║  │ Attribution  (3 layer: inline-MCP   │  ║
              ║  │               / hook / netstat)     │  ║
              ║  ├─────────────────────────────────────┤  ║
              ║  │ Classifier   (manifest L0 + L3 gate)│  ║
              ║  ├─────────────────────────────────────┤  ║
              ║  │ Recorder     (SQLite per-lane)      │  ║
              ║  ├─────────────────────────────────────┤  ║
              ║  │ Reverter     (五件套 compensator)   │  ║
              ║  └─────────────────────────────────────┘  ║
              ║  ⏸ Approval Gate — blocks ④              ║
              ╚═══════════════════════════════════════════╝
                                         │
                                         ▼
                               api.github.com (sandbox)
```

### 2.1 请求生命周期时序图

单个 `POST /repos/{o}/{r}/pulls` 从 agent 出发到响应回来的完整时序：

```
 Agent           Proxy         LaneResolver     Classifier       Storage       Upstream
   │               │                 │               │              │              │
   │── POST ──────▶│                 │               │              │              │
   │   (via env    │                 │               │              │              │
   │    HTTP_PROXY)│                 │               │              │              │
   │               │── resolveLaneId ▶│               │              │              │
   │               │                 │── L1 header ──▶                             │
   │               │                 │   parse       │              │              │
   │               │                 │◀─ laneId, hi  │              │              │
   │               │◀──── laneId ────│               │              │              │
   │               │                                                │              │
   │               │──── parsedReq ──────────────▶│                │              │
   │               │                              │── lookup ──────▶              │
   │               │                              │   manifest    │              │
   │               │                              │── ③/④ decide  │              │
   │               │◀──── ClassifierResult ──────│                │              │
   │               │                                                │              │
   │               │──── if ③: capture before-image (sync GET) ──────────────────▶│
   │               │◀──────────────────────────────────────────────── beforeImage │
   │               │                                                               │
   │               │──── appendOp (lane, op, beforeImage) ────────▶│              │
   │               │                                               │── TX write ──│
   │               │                                               │── plan comp ─│
   │               │                                                │              │
   │               │──── if ④ strict: HANG + notify on_approval_pending ─────────┐
   │               │                                                │            │
   │               │◀────── user runs `cairn approve <op-id>` ──────────────────┘
   │               │                                                │              │
   │               │──── forward original request ─────────────────────────────▶│
   │               │◀──── upstream response ───────────────────────────────────│
   │               │                                                              │
   │               │──── updateOp(responseStatus, responseBody) ─▶│              │
   │◀─ 201 body ───│                                               │              │
   │               │                                                              │

 (Later: `cairn revert lane-X` fetches ops + compensations and runs engine)
```

### 2.2 稳定契约三件套

Preview → v0.1 不变，所有用户 / 插件代码都绑定这三样：

1. **HTTP proxy header 协议**
   - 入方向：`x-cairn-lane-id`（Layer 1/2 显式标注）、`x-cairn-agent-id`（Claude Code subagent name）、`x-cairn-idempotency-key`（可选，用于 revert 去重）
   - 出方向：Cairn 从客户端请求剥离所有 `x-cairn-*` header 再转发，**不污染上游**

2. **CLI 命令名 + 退出码契约**：见 §8

3. **MCP 工具 schema**：Preview 不暴露 MCP（仅 HTTP），但 §9 已冻结 v0.1 的 schema，Preview 的 receipt 格式与之一致

### 2.3 HTTPS 观察模型（双轨策略）

Preview 存在一个**核心悖论**：声称不做 HTTPS MITM，但同时要求代理看到 GitHub API 的 method / path / body 才能做 classification 和 before-image——标准 `CONNECT` 隧道下 Cairn 只看见加密的 TCP 字节流，拿不到明文 HTTP 语义。为此 Preview 给出**双轨**方案，两者互不干扰：

**默认轨 — Local mock GitHub server（Preview demo 专用）**

- `demo/gh-mock-server.ts`（§10.4 给完整骨架）：基于 Bun 的 HTTP server，**只监听 127.0.0.1:3000**，模拟 GitHub REST API 的 Preview 8 端点（method / path / status code / headers / body shape 与真 GitHub 一致）
- Proxy 以 HTTP（非 HTTPS）方式前置在 mock 前面，完整拦截所有流量、看到明文 body
- 用户 `bun demo/run-demo.sh` 一键起 mock + cairn proxy，整条 demo 流水线不需要任何 CA / cert 配置
- **Preview 所有 fault injection / E2E 单测默认走这条**，零外网依赖、CI 稳定

**可选轨 — HTTPS MITM（opt-in，Preview 晚期 stretch goal）**

- `cairn init --with-mitm`：生成自签 root CA（`~/.cairn/ca.pem` + `~/.cairn/ca.key`），引导 macOS Keychain / Linux `update-ca-certificates` 安装
- `cairn start --mitm`：代理启动时加载 CA，对 `CONNECT api.github.com:443` 隧道做 on-the-fly 证书签发、拦截 TLS 明文
- 在 §13.4 明确标注已知限制：Windows cert store 未自动化、Node `undici` / Python `certifi` / Go `x509` 需独立配置环境变量或 patch
- **Preview demo 不依赖这条**，只作为 dogfooder / 高阶用户的独立路径

**流量走向示意**

```
默认轨（mock）：
  agent --HTTP--> cairn:7778 --HTTP--> localhost:3000 (mock-gh)
                     ↑ 明文可观察：method/path/body 全可见

可选轨（MITM）：
  agent --HTTPS--> cairn:7778 (解 TLS、签自证、重新加密) --HTTPS--> api.github.com
                     ↑ 明文在代理内存中可见；要求客户端信任 Cairn CA
```

`§3` 起后续章节的所有 "classifier 看到 body"、"compensator fetch before-image"、"proxy body 观察" 等语义，**Preview 阶段均假定流量已明文化**（经上述两轨之一）。定位书里 HTTPS MITM 作为 "known issue" 的表述在此被精炼为双轨决策，不扩大 scope。

### 2.4 被动基础设施原则

Cairn **不决策**、不推送、不 orchestrate。只做三件事：(a) 被 agent 的 HTTP 客户端调用；(b) 被用户 CLI 触发；(c) 在 approval gate 时阻塞等待 `cairn approve`。任何"Cairn 要不要自动 revert / 要不要主动通知"的问题答案都是 **no**，交给宿主。

**已知风险 + 应对**
- **没有 MCP proxy 的 call 无法被记录**：文档明示 "Preview 只支持 HTTP 出站的 agent"，本地 MCP 调用（如 `fs.write`）不在 Preview 范围
- **HTTPS 客户端需信任 Cairn CA**：README 给出 `mkcert`-based 配置步骤，失败则回退到 HTTP-only sandbox（即 GitHub API 走 HTTP→proxy→HTTPS 上游）
- **上游超时会把 proxy 自己挂住**：每次 forward 都带 30s hard timeout，超时返回 504 并标 op `INFRA_ERR`

---

## 3. Lane Attribution 实现（3 层叠加 + 降级）

> **HTTPS 观察前置声明（r1 新增）**：本章及其后 §4 / §5 / §7 / §10 所有示例代码均假设请求流量对代理**明文可见**——由 §2.3 的两轨之一提供（默认走 mock GitHub server 的 HTTP 明文；可选走 `--mitm` 的 TLS 拦截）。若既未跑 mock 也未启用 MITM，Cairn 只能在 CONNECT 隧道级别记录 `(destination host, byte counts)`，`class / before-image / compensator chain` 全部不可计算，proxy 按 `NOT_IN_MANIFEST` 升级 ④ 处理。

POC 结论见 `D:\lll\cairn\cairn-poc\RESULTS.md`：三层叠加后 MVP 场景单 agent **100%**、multi-subagent 错归属率 **1-3%**。Preview 三层同时上线，优先级 Layer 1 > Layer 2 > Layer 3。

### 3.1 LaneResolver 总体结构

`src/attribution/resolver.ts`：

```ts
import type { IncomingRequest, LaneId, LaneResolutionResult } from '../types';
import { parseInlineMcpToken } from './inline-mcp';
import { extractMetaLaneId, readHookSocketRecent } from './hook-socket';
import { pidFromRemotePort, laneFromPid } from './pid-lookup';

export class LaneResolver {
  constructor(private hookLookback: number = 2000 /* ms */) {}

  async resolveLaneId(req: IncomingRequest): Promise<LaneResolutionResult> {
    const l1 = this.tryLayer1(req);
    const l2 = await this.tryLayer2(req);
    const l3 = await this.tryLayer3(req);
    return this.merge(l1, l2, l3);
  }

  private tryLayer1(req: IncomingRequest): LaneId | null {
    const hdr = req.headers['x-cairn-lane-id'];
    if (typeof hdr === 'string' && /^lane_[0-9A-Z]{26}$/.test(hdr)) return hdr as LaneId;
    const urlMatch = req.url.match(/\/_cairn\/mcp\/(lane_[0-9A-Z]{26})/);
    return urlMatch ? (urlMatch[1] as LaneId) : null;
  }

  private async tryLayer2(req: IncomingRequest): Promise<LaneId | null> {
    // `_meta["cairn.dev/lane-id"]` 只在 MCP 请求体里出现；Preview HTTP-only，故同时读 hook socket
    const recent = await readHookSocketRecent(this.hookLookback);
    const pid = await pidFromRemotePort(req.remotePort);
    if (!pid) return null;
    const rec = recent.find(r => r.pid === pid);
    return rec ? (rec.laneId as LaneId) : null;
  }

  private async tryLayer3(req: IncomingRequest): Promise<LaneId | null> {
    const pid = await pidFromRemotePort(req.remotePort);
    if (!pid) return null;
    return laneFromPid(pid);
  }

  private merge(l1: LaneId | null, l2: LaneId | null, l3: LaneId | null): LaneResolutionResult {
    const all = [l1, l2, l3].filter((x): x is LaneId => !!x);
    if (all.length === 0) return { laneId: null, confidence: 'none', source: 'none' };
    if (l1 && (!l2 || l2 === l1) && (!l3 || l3 === l1)) {
      return { laneId: l1, confidence: 'high', source: 'layer1' };
    }
    if (l2 && (!l3 || l3 === l2)) {
      return { laneId: l2, confidence: 'high', source: 'layer2' };
    }
    if (l3 && !l1 && !l2) {
      return { laneId: l3, confidence: 'medium', source: 'layer3' };
    }
    // 三层冲突
    return { laneId: l1 ?? l2 ?? l3!, confidence: 'low', source: 'conflict' };
  }

  classifyAttributionConfidence(r: LaneResolutionResult): 'high' | 'medium' | 'low' | 'none' {
    return r.confidence;
  }
}
```

### 3.2 Layer 1：Per-subagent inline MCP server

Claude Code subagent frontmatter 里 `mcpServers` 支持内联定义。`cairn init` 扫描 `.claude/agents/*.md`，为每份 subagent 改写 frontmatter，注入一个**唯一 URL/token 编码 lane-id** 的 inline MCP server 条目 + 一对环境变量 `HTTP_PROXY` / `HTTPS_PROXY`。

**签名 + 职责**

```ts
// src/attribution/inline-mcp.ts
/** 解析 URL 或 token 中的 lane_id，给 Layer 1 入口用 */
export function parseInlineMcpToken(token: string): LaneId | null {
  const m = token.match(/^lane_[0-9A-Z]{26}$/);
  return m ? (token as LaneId) : null;
}

/** 生成 cairn init 写回 frontmatter 的内联 MCP URL */
export function generateInlineMcpUrl(laneId: LaneId, subagentName: string): URL {
  const u = new URL(`http://127.0.0.1:7778/_cairn/mcp/${laneId}`);
  u.searchParams.set('agent', subagentName);
  return u;
}
```

**`cairn init` 主流程（§8 会再次引用）**：

```ts
// src/cli/init.ts
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { glob } from 'glob';
import yaml from 'js-yaml';
import { ulid } from 'ulid';
import type { SubagentFrontmatter } from '../types';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

export class CairnInit {
  constructor(private projectRoot: string, private proxyUrl = 'http://127.0.0.1:7778') {}

  scanClaudeSubagents(): { path: string; fm: SubagentFrontmatter; body: string }[] {
    const files = glob.sync(join(this.projectRoot, '.claude/agents/*.md'));
    return files.map(p => {
      const raw = readFileSync(p, 'utf8');
      const m = raw.match(FRONTMATTER_RE);
      if (!m) throw new Error(`no frontmatter: ${p}`);
      const fm = yaml.load(m[1]) as SubagentFrontmatter;
      return { path: p, fm, body: m[2] };
    });
  }

  injectCairnFrontmatter(fm: SubagentFrontmatter): SubagentFrontmatter {
    const laneId = `lane_${ulid()}` as LaneId;
    const next: SubagentFrontmatter = { ...fm };
    next.env = { ...(fm.env ?? {}),
      HTTP_PROXY: this.proxyUrl,
      HTTPS_PROXY: this.proxyUrl,
      CAIRN_LANE_ID: laneId,
      NODE_OPTIONS: `--import ${join(this.projectRoot, '.claude/preload/cairn-undici.mjs')}`,
    };
    next.mcpServers = { ...(fm.mcpServers ?? {}),
      cairn: {
        url: `${this.proxyUrl}/_cairn/mcp/${laneId}`,
        headers: { 'x-cairn-lane-id': laneId, 'x-cairn-agent-id': fm.name },
      },
    };
    return next;
  }

  async writeBackWithConfirmation(path: string, modified: SubagentFrontmatter, body: string): Promise<void> {
    const dumped = yaml.dump(modified, { lineWidth: 120 });
    const out = `---\n${dumped}---\n${body}`;
    writeFileSync(path, out, 'utf8');
  }

  async run(): Promise<{ modified: number; laneMap: Record<string, LaneId> }> {
    const subs = this.scanClaudeSubagents();
    const laneMap: Record<string, LaneId> = {};
    for (const s of subs) {
      const injected = this.injectCairnFrontmatter(s.fm);
      laneMap[s.fm.name] = injected.env!.CAIRN_LANE_ID as LaneId;
      await this.writeBackWithConfirmation(s.path, injected, s.body);
    }
    // 同时生成 undici preload
    this.writePreload();
    return { modified: subs.length, laneMap };
  }

  private writePreload(): void {
    const p = join(this.projectRoot, '.claude/preload/cairn-undici.mjs');
    const content = `import { setGlobalDispatcher, ProxyAgent } from 'undici';
if (process.env.HTTP_PROXY) {
  setGlobalDispatcher(new ProxyAgent(process.env.HTTP_PROXY));
}
`;
    if (!existsSync(p)) writeFileSync(p, content, 'utf8');
  }
}
```

**错误路径**
- `no frontmatter: <path>` → 当前文件不是 Claude Code subagent，跳过并 warn，不中止
- `fm.name` 缺失 → 抛 `CairnError('INVALID_SUBAGENT', { path })`
- `~/.claude/agents/` 不存在 → `cairn init` 打印 "no subagents found, skipping Layer 1 injection" 但不报错

**测试骨架**

```ts
test('injectCairnFrontmatter adds env + mcpServers without losing existing fields', () => {
  const init = new CairnInit('/tmp/prj');
  const src: SubagentFrontmatter = { name: 'code-agent', description: 'x',
                                     env: { FOO: 'bar' }, mcpServers: { other: { url: 'http://x' } } };
  const out = init.injectCairnFrontmatter(src);
  expect(out.env!.FOO).toBe('bar');
  expect(out.env!.HTTP_PROXY).toBe('http://127.0.0.1:7778');
  expect(out.env!.CAIRN_LANE_ID).toMatch(/^lane_[0-9A-Z]{26}$/);
  expect(out.mcpServers!.other).toBeDefined();
  expect(out.mcpServers!.cairn).toBeDefined();
});
```

### 3.3 Layer 2：Hook 注入 + `_meta` prefix + socket 反查

subagent frontmatter 的 `hooks` 字段挂 `PreToolUse` hook，把 PID + agent name + laneId 写进一个 per-session local socket。proxy 在看到某个未带 header 的请求时，通过 `remoteAddress:remotePort → PID` 查询 + socket 里最近一条"PID=X is lane Y"记录，完成反查。

**签名**

```ts
// src/attribution/hook-socket.ts
export interface HookRecord { pid: number; laneId: string; agent: string; ts: number }

/** MCP 请求体里 _meta["cairn.dev/lane-id"] 提取（v0.1 MCP-proxy 用，Preview 只在 HTTP body=json 时尝试） */
export function extractMetaLaneId(mcpParams: unknown): LaneId | null {
  if (!mcpParams || typeof mcpParams !== 'object') return null;
  const meta = (mcpParams as any)._meta;
  if (!meta) return null;
  const v = meta['cairn.dev/lane-id'];
  return typeof v === 'string' && /^lane_[0-9A-Z]{26}$/.test(v) ? (v as LaneId) : null;
}

/** 读取 lookbackMs 窗口内的 hook 记录 */
export async function readHookSocketRecent(lookbackMs: number): Promise<HookRecord[]> {
  const now = Date.now();
  const path = process.platform === 'win32'
    ? '\\\\.\\pipe\\cairn-attribution'
    : '/tmp/cairn-attribution.sock';
  try {
    // Preview 简化：hook 写成 append-only 文件 /tmp/cairn-attribution.log，socket 是 stretch
    const log = await Bun.file(path + '.log').text().catch(() => '');
    const lines = log.trim().split('\n').filter(Boolean);
    return lines.flatMap(l => {
      try {
        const r = JSON.parse(l) as HookRecord;
        return (now - r.ts) <= lookbackMs ? [r] : [];
      } catch { return []; }
    });
  } catch { return []; }
}

/** 给 cairn init 写的 hook 脚本使用：构造一条 payload */
export function buildHookPayload(laneId: LaneId, agent: string): HookRecord {
  return { pid: process.pid, laneId, agent, ts: Date.now() };
}
```

**Hook 脚本（Unix）——由 `cairn init` 生成**：

```bash
#!/usr/bin/env bash
# .claude/hooks/cairn-pretool.sh
: "${CC_SUBAGENT_NAME:=main}"
: "${CAIRN_LANE_ID:=lane_UNKNOWN}"
printf '{"pid":%d,"laneId":"%s","agent":"%s","ts":%d}\n' \
  "$$" "$CAIRN_LANE_ID" "$CC_SUBAGENT_NAME" "$(($(date +%s%N)/1000000))" \
  >> /tmp/cairn-attribution.sock.log
```

**Windows hook 脚本**：

```powershell
# .claude\hooks\cairn-pretool.ps1
$rec = @{ pid = $PID
          laneId = [Environment]::GetEnvironmentVariable('CAIRN_LANE_ID')
          agent = [Environment]::GetEnvironmentVariable('CC_SUBAGENT_NAME')
          ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress
Add-Content -Path "$env:TEMP\cairn-attribution.sock.log" -Value $rec
```

**错误路径**
- socket / log 文件不存在 → 返回空数组，让 Layer 3 接手
- JSON 损坏一行 → 跳过单行，不中止

**测试骨架**

```ts
test('extractMetaLaneId pulls lane id from _meta namespace', () => {
  expect(extractMetaLaneId({ _meta: { 'cairn.dev/lane-id': 'lane_01HX9K8PQRZABCDEFGHJKMNPQR' } }))
    .toBe('lane_01HX9K8PQRZABCDEFGHJKMNPQR');
  expect(extractMetaLaneId({ _meta: { 'other': 'x' } })).toBeNull();
  expect(extractMetaLaneId(null)).toBeNull();
});
```

### 3.4 Layer 3：连接元信息 PID 归属

当 Layer 1/2 都未命中时，proxy 从 socket 拿 `remoteAddress:remotePort`，跑 `netstat -ano`（Windows）或 `ss -tpn` / `lsof -nP -iTCP:<port>`（Linux / macOS）反查 owning PID，再按 process tree 归到 Claude Code 的哪个 subagent 子进程。POC 数据（`D:\lll\cairn\cairn-poc\pid-lookup.mjs`）**6/6 命中，延迟 52-179ms**。

**Windows 实现**：

```ts
// src/attribution/pid-lookup.ts (Windows branch)
import { $ } from 'bun';

export async function pidFromConnection_Windows(remotePort: number): Promise<number | null> {
  // netstat -ano -p TCP 在 Windows 输出列：Proto Local Foreign State PID
  const proc = Bun.spawn(['netstat', '-ano', '-p', 'TCP'], { stdout: 'pipe' });
  const stdout = await new Response(proc.stdout).text();
  for (const line of stdout.split(/\r?\n/)) {
    //   TCP    127.0.0.1:54321       127.0.0.1:7778         ESTABLISHED     12345
    const m = line.match(/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+127\.0\.0\.1:(\d+)\s+ESTABLISHED\s+(\d+)\s*$/);
    if (!m) continue;
    const localPort = Number(m[1]);
    const foreignPort = Number(m[2]);
    if (localPort === remotePort && foreignPort === 7778) return Number(m[3]);
  }
  return null;
}
```

**Linux / macOS 实现**：

```ts
export async function pidFromConnection_Unix(remotePort: number): Promise<number | null> {
  // ss -tnp '( sport = :<port> )' —— Linux
  // 输出 users:(("node",pid=12345,fd=20))
  try {
    const proc = Bun.spawn(['ss', '-tnp', `( sport = :${remotePort} )`], { stdout: 'pipe' });
    const stdout = await new Response(proc.stdout).text();
    const m = stdout.match(/pid=(\d+)/);
    if (m) return Number(m[1]);
  } catch { /* ss 不存在，试 lsof */ }
  try {
    const proc = Bun.spawn(['lsof', '-nP', '-iTCP:' + remotePort, '-sTCP:ESTABLISHED'], { stdout: 'pipe' });
    const stdout = await new Response(proc.stdout).text();
    const lines = stdout.split('\n').slice(1); // skip header
    const first = lines.find(l => l.trim().length > 0);
    if (first) {
      const cols = first.split(/\s+/);
      return Number(cols[1]);
    }
  } catch { /* give up */ }
  return null;
}

export async function pidFromConnection(remotePort: number): Promise<number | null> {
  return process.platform === 'win32'
    ? pidFromConnection_Windows(remotePort)
    : pidFromConnection_Unix(remotePort);
}
```

**PID → laneId 反查**：

```ts
// 读 ~/.cairn/pid-lane-map.json，cairn init 落下后由 subagent 进程在启动时写自己的 PID
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function laneFromPid(pid: number): LaneId | null {
  try {
    const home = process.env.HOME || process.env.USERPROFILE!;
    const raw = readFileSync(join(home, '.cairn', 'pid-lane-map.json'), 'utf8');
    const map = JSON.parse(raw) as Record<string, LaneId>;
    return map[String(pid)] ?? null;
  } catch {
    return null;
  }
}
```

**错误路径**
- netstat / ss / lsof 不在 PATH → 返回 `null`，Layer 3 直接放弃；`confidence: none`
- remotePort 不是 IPv4 localhost → 返回 null（Preview 不处理 IPv6 link-local）

**测试骨架**（mock 子进程）：

```ts
test('pidFromConnection_Windows parses netstat output', async () => {
  const mockOut = `
  Proto  Local           Foreign         State          PID
  TCP    127.0.0.1:54321 127.0.0.1:7778  ESTABLISHED    9876
`;
  const pid = parseNetstatForTest(mockOut, 54321);
  expect(pid).toBe(9876);
});
```

### 3.5 undici monkey-patch

**坑**：Node 18+ 的 native `fetch`（undici）默认不读 `HTTP_PROXY` 环境变量——subagent 代码如果直接 `fetch()` 会绕过 Cairn proxy。`cairn init` 写 `.claude/preload/cairn-undici.mjs`，同时在 subagent frontmatter 的 env 里注入 `NODE_OPTIONS=--import <abs>/cairn-undici.mjs`。

```ts
// src/attribution/undici-patch.ts —— 独立 export，方便在 Bun/Node 下都能 self-test
export function installUndiciProxyPatch(cairnProxyUrl: URL): void {
  if (typeof (globalThis as any).Bun !== 'undefined') return; // Bun 自带 fetch 走 HTTP_PROXY
  // Node branch
  // dynamic import 避免 Bun 下 undici 未装
  import('undici').then(({ setGlobalDispatcher, ProxyAgent }) => {
    setGlobalDispatcher(new ProxyAgent(cairnProxyUrl.toString()));
  });
}
```

### 3.6 错归属处理

Layer 三层并行跑，结果汇总：
- **三层一致 / Layer 1 命中** → `confidence: high`，lane 直接落
- **Layer 3 独自兜底命中** → `confidence: medium`，op 写入该 lane 但 **`cairn revert`** 默认 `--dry-run` + 醒目警告
- **三层冲突** → `confidence: low`，op 入 `lane_quarantine`，CLI `cairn lanes` 置顶提示

**已知风险 + 应对**
- **multi-subagent 同时发请求时 netstat 抖动**：Layer 3 窗口期 200ms 内有多个 op，用 "socket→socket 建连时刻 vs agent hook 时间戳" 对齐，不对齐就标 partial-attribution
- **用户不跑 `cairn init`**：proxy 启动时检测 `.claude/agents/*.md` 里没有 Cairn 注入，一行警告 + 继续以 Layer 3 only 模式跑，错归属率上升到 ~10%，receipt 明示 "low confidence"
- **Windows netstat 列宽受 locale 影响**：用 regex 而不是固定列位，并支持中文 Windows 下的 `ESTABLISHED` 翻译（如遇 `已建立` fallback 关键字匹配）

---

## 4. Classification 实现（Preview manifest-only）

Preview 阶段**只做 L0 + L3**，L1（规则引擎）/ L2（LLM fallback）延到 v0.1。

**L0 Per-adapter manifest**：`manifests/github.yaml` 列全 8 个 Preview 端点（附录 B 全量）。Classifier 启动时 parse 一次、内存索引化（按 `method + path-template`）。

**L3 Approval gate**：命中 manifest 里 `class: "④"` 的端点 → 按 mode（strict/acceptIrreversible/bypass）分流。

**未命中 manifest 的处理**：Preview 阶段**保守走 ④**（不放行、等 approval）。不引入 L1 rule engine、不猜 "GET 一定 pure-read"。原因：Round 2 验证显示 rule-only 准确率 43-57%，风险高于收益。

### 4.1 Classifier 总体类

```ts
// src/classifier/classify.ts
import type { ParsedRequest, ClassifierResult, ManifestEntry, ModeConfig } from '../types';
import { ManifestRegistry } from './manifest';

export class Classifier {
  constructor(
    private manifests: ManifestRegistry,
    private mode: ModeConfig,
  ) {}

  classify(req: ParsedRequest): ClassifierResult {
    const entry = this.matchManifestEntry(req);
    if (!entry) return this.applyFallbackRule(req);
    if (entry.class === '④') {
      const shouldGate = this.evaluateApprovalCondition(entry, req);
      return {
        class: '④',
        reason: entry.classReason,
        entry,
        approvalRequired: shouldGate && this.mode.mode !== 'bypass',
        acceptedIrreversible: this.mode.mode === 'acceptIrreversible',
      };
    }
    return {
      class: entry.class,
      reason: entry.classReason,
      entry,
      approvalRequired: false,
      acceptedIrreversible: false,
    };
  }

  private matchManifestEntry(req: ParsedRequest): ManifestEntry | null {
    return this.manifests.lookup(req.method, req.urlPath);
  }

  private applyFallbackRule(req: ParsedRequest): ClassifierResult {
    // Preview 保守策略：未命中 manifest 一律升级 ④
    return {
      class: '④',
      reason: 'NOT_IN_MANIFEST',
      approvalRequired: this.mode.mode !== 'bypass',
      acceptedIrreversible: this.mode.mode === 'acceptIrreversible',
    };
  }

  private evaluateApprovalCondition(entry: ManifestEntry, req: ParsedRequest): boolean {
    // Preview: requires_approval_when 支持两种形态
    //   [{ always: true }] → 必 gate
    //   [{ expr: "body.state === 'closed'" }] → 布尔表达式（v0.1 启用，Preview 不跑）
    for (const cond of entry.requiresApprovalWhen) {
      if (cond.always) return true;
      // Preview 不做 expr eval，直接忽略复杂条件（保证"拍死" + 简单）
    }
    return false;
  }
}
```

### 4.2 ManifestRegistry

```ts
// src/classifier/manifest.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import type { ManifestEntry, ManifestFile } from '../types';
import { matchPathPattern } from './path-match';

interface IndexKey { method: string; pathTemplate: string }

export class ManifestRegistry {
  private entries: ManifestEntry[] = [];
  private byMethod: Map<string, ManifestEntry[]> = new Map();

  loadFromDirectory(dir: string): void {
    const files = ['github.yaml']; // Preview: 硬编码，v0.1 扫描 dir/*.yaml
    for (const f of files) {
      const raw = readFileSync(join(dir, f), 'utf8');
      const parsed = yaml.load(raw) as ManifestFile;
      this.validate(parsed, f);
      for (const e of parsed.entries) {
        const entry = this.normalize(e, parsed);
        this.entries.push(entry);
        const arr = this.byMethod.get(entry.method) ?? [];
        arr.push(entry);
        this.byMethod.set(entry.method, arr);
      }
    }
  }

  lookup(method: string, pathPattern: string): ManifestEntry | null {
    const arr = this.byMethod.get(method.toUpperCase()) ?? [];
    for (const entry of arr) {
      if (matchPathPattern(entry.path, pathPattern)) return entry;
    }
    return null;
  }

  private validate(file: ManifestFile, name: string): void {
    if (!file.adapter) throw new Error(`${name}: missing adapter`);
    if (!Array.isArray(file.entries)) throw new Error(`${name}: entries must be array`);
    for (const e of file.entries) {
      if (!e.method || !e.path || !e.class) {
        throw new Error(`${name}: incomplete entry ${JSON.stringify(e)}`);
      }
      if (!['①', '②', '③', '④'].includes(e.class)) {
        throw new Error(`${name}: bad class ${e.class}`);
      }
    }
  }

  private normalize(raw: any, file: ManifestFile): ManifestEntry {
    return {
      adapter: file.adapter,
      method: String(raw.method).toUpperCase(),
      path: String(raw.path),
      class: raw.class,
      classReason: raw.class_reason ?? '',
      beforeImage: {
        captureVia: raw.before_image?.capture_via ?? null,
        extraLatencyBudgetMs: raw.before_image?.extra_latency_budget_ms ?? 500,
        coverageGaps: raw.before_image?.coverage_gaps ?? [],
      },
      undoStrategy: {
        tier: raw.undo_strategy?.tier ?? 'L0-pure',
        compensatorChain: raw.undo_strategy?.compensator_chain ?? [],
        unreversibleTail: raw.undo_strategy?.unreversible_tail ?? [],
      },
      requiresApprovalWhen: raw.requires_approval_when ?? [],
    };
  }
}
```

### 4.3 Path pattern matcher（RFC 6570 简化版）

支持 `/repos/{owner}/{repo}/pulls/{pull_number}` 这类占位符。Preview 不支持 level-2 扩展（`{+var}` / `{?q}`）。

```ts
// src/classifier/path-match.ts

const CACHE = new Map<string, RegExp>();

/** 把 "/repos/{o}/{r}/pulls/{n}" 编译为 /^/repos/([^/]+)/([^/]+)/pulls/([^/]+)$/ */
export function compileTemplate(template: string): RegExp {
  const cached = CACHE.get(template);
  if (cached) return cached;
  const pattern = template.replace(/\{[^}]+\}/g, '([^/]+)')
                          .replace(/\//g, '\\/');
  const re = new RegExp(`^${pattern}$`);
  CACHE.set(template, re);
  return re;
}

/** 返回 match 数组或 null；调用方可以从 match.groups 读变量（Preview 不开 named groups，用 index） */
export function matchPathPattern(template: string, actual: string): RegExpMatchArray | null {
  const re = compileTemplate(template);
  return actual.match(re);
}

/** 把 template + match 结果拆成 { owner, repo, ... } 对象，给 before-image 抓取拼 URL 用 */
export function extractPathVars(template: string, actual: string): Record<string, string> | null {
  const m = matchPathPattern(template, actual);
  if (!m) return null;
  const keys = [...template.matchAll(/\{([^}]+)\}/g)].map(x => x[1]);
  const out: Record<string, string> = {};
  keys.forEach((k, i) => { out[k] = m[i + 1]; });
  return out;
}
```

**测试骨架**

```ts
test('matchPathPattern handles GitHub PR path', () => {
  expect(matchPathPattern('/repos/{owner}/{repo}/pulls/{num}', '/repos/x/y/pulls/42')).toBeTruthy();
  expect(matchPathPattern('/repos/{owner}/{repo}/pulls/{num}', '/repos/x/y/pulls/42/files')).toBeNull();
});

test('extractPathVars decodes correct variable names', () => {
  const v = extractPathVars('/repos/{owner}/{repo}/pulls/{num}', '/repos/x/y/pulls/42');
  expect(v).toEqual({ owner: 'x', repo: 'y', num: '42' });
});
```

### 4.4 模板变量契约（Template Resolution Contract，r1 新增）

Preview 所有 manifest 里 compensator chain / before_image 的 URL / body / optimistic_lock value 可能含占位符。r1 前使用混搭语法（`{number}`、`{{before_image.title}}`、`{head.ref}`）且只在 before-image 阶段从 path 抽值、compensation 执行时直接发 `step.plan.url/body` 原样——字段不会被填充。r1 统一如下契约。

**统一语法**：`${namespace.dotted.path}`，唯一形式，禁止 `{xxx}` / `{{xxx}}` / `%{}` 混用。

**支持的 namespace**：

| namespace | 来源 | 何时可用 |
|---|---|---|
| `${path.xxx}` | Path template 匹配结果（见 `extractPathVars`） | forward 请求一进来就有 |
| `${request.xxx}` | forward request body / header | forward 请求一进来就有 |
| `${response.xxx}` | forward 上游响应 body | forward 完成后才有 |
| `${before_image.xxx}` | `captureBeforeImage()` 抓的 GET 快照 body / etag | 前像成功后才有 |

**两次绑定**：

- **第一次（生成 compensation 时，forward 完成后）**：Recorder 把 `path / request / response / before_image` 全量填入 `ResolutionContext`，调用 `TemplateResolver.resolve()` 把 `compensator_chain` step 展开——能解析的字面量（如 `${path.number}`、`${response.id}`）当场替换；仍含占位符的部分（比如将来的 probe 结果）保留原字符串，落 `compensations.plan` 列。
- **第二次（execute compensation 时）**：Compensator Engine 在发出 step 前**再次** `resolve()`；此时 before_image 等字段在 SQLite 里已持久化、重新装配进 `ResolutionContext`。即便 Cairn 进程中途 kill、重启后 `--resume`，也能从 SQLite 完整重建 context。

**未解析占位符 = 硬错误**：若 resolve 结束后字符串仍含 `${...}`，`TemplateResolver` 抛 `UNRESOLVED_PLACEHOLDER`，engine 在 `executeStep` 外层 catch 映射为 `StepResult.FAIL(INCOMPLETE_BEFORE_IMAGE)`——绝不把占位符发到上游。

**实现骨架**：

```ts
// src/reverter/template.ts
export interface ResolutionContext {
  path: Record<string, string>;            // 来自 extractPathVars
  request?: Record<string, unknown>;       // forward 请求 body（已 JSON.parse）
  response?: Record<string, unknown>;      // forward 响应 body
  before_image?: Record<string, unknown>;  // captureBeforeImage().body + { etag }
}

export class TemplateResolver {
  constructor(private context: ResolutionContext) {}

  /** 字符串或对象深度解析；数组递归 */
  resolve<T extends string | Record<string, unknown> | unknown[] | null | undefined>(
    template: T,
  ): T {
    if (template == null) return template;
    if (typeof template === 'string') return this.resolveString(template) as T;
    if (Array.isArray(template)) return template.map(v => this.resolve(v as any)) as T;
    if (typeof template === 'object') return this.resolveObject(template as Record<string, unknown>) as T;
    return template;
  }

  private resolveString(str: string): string {
    // 匹配 ${ns.a.b.c}
    return str.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_.]*)\}/g, (_, dotted) => {
      const v = this.lookup(dotted);
      if (v === undefined) this.throwOnUnresolved(dotted);
      return String(v);
    });
  }

  private resolveObject(obj: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = this.resolve(v as any);
    return out;
  }

  private lookup(dottedPath: string): unknown {
    const [ns, ...rest] = dottedPath.split('.');
    const root = (this.context as any)[ns];
    if (root == null) return undefined;
    return rest.reduce<unknown>((acc, key) =>
      (acc != null && typeof acc === 'object') ? (acc as any)[key] : undefined, root);
  }

  private throwOnUnresolved(placeholder: string): never {
    const available = Object.keys(this.context).filter(k => this.context[k as keyof ResolutionContext] != null);
    throw new CairnError('UNRESOLVED_PLACEHOLDER', { placeholder, available });
  }
}
```

**调用点明确化**：

- Recorder 在 forward 完成后：`const step1 = new TemplateResolver({ path, request, response, before_image }).resolve(rawStepPlan);` → persist
- Compensator 在 `executeStep` 发出前：`const finalPlan = new TemplateResolver(ctx).resolve(step.plan);` → `httpForwarder(finalPlan)`

测试骨架：

```ts
test('TemplateResolver substitutes multi-namespace dotted paths', () => {
  const r = new TemplateResolver({
    path: { owner: 'acme', repo: 'web', number: '42' },
    before_image: { title: 'old', etag: 'W/"x"' },
  });
  expect(r.resolve('/repos/${path.owner}/${path.repo}/pulls/${path.number}'))
    .toBe('/repos/acme/web/pulls/42');
  expect(r.resolve({ title: '${before_image.title}' })).toEqual({ title: 'old' });
});

test('TemplateResolver throws UNRESOLVED_PLACEHOLDER on missing value', () => {
  const r = new TemplateResolver({ path: {} });
  expect(() => r.resolve('${response.id}')).toThrow(/UNRESOLVED_PLACEHOLDER/);
});
```

### 4.5 分类结果如何传给 Reverter

Classifier 对 **`class: ③`** 的 op 额外做两件事（由 Recorder 调度，不在 Classifier 内部做以保证 Classifier 无 I/O 副作用便于单测）：

1. 从 manifest 读 `before_image.capture_via`，**在 forward 请求出站前**同步触发一次 GET 拿到 before-image；写入 `ops.before_image` JSON 列
2. 从 manifest 读 `undo_strategy.compensator_chain`，展开成具体的 `Compensation` step 列表，写入 `compensations` 表（状态 `PENDING`）

分类结果 + before-image + compensation plan 全部通过 Recorder 落 SQLite——Reverter 执行时**只看 SQLite，不看 in-memory 状态**（支持 Cairn 守护进程崩溃后重启继续 revert）。

**错误路径**
- `NOT_IN_MANIFEST` → receipt 里 `reason: 'NOT_IN_MANIFEST'`，CLI 给建议 "add entry to manifests/github.yaml"
- manifest YAML 解析失败 → `cairn start` 直接 exit 1，打印 line/col

**已知风险 + 应对**
- **before-image capture 失败**（GET 上游 500/403）：标 op 为 `BEFORE_IMAGE_UNAVAILABLE`，默认升级为 ④
- **Preview 把 ④ 兜底的策略会过度拦截**：demo 本身只跑 8 个已知端点，不会误触发；实际用户如果调 GitHub Projects API 会被 gate 住——文档明示 "Preview 只保证这 8 端点"

---

## 5. Compensator Engine 实现（五件套 + 状态机）

POC `D:\lll\cairn\cairn-poc\compensator\FAULT_INJECTION\FAULT_RESULTS.md` 证明：**7 个 naive 场景下 5 个会静默撒谎**（F1a / F1c / F2a / F3a / F3b 全部 exit 0 但真实状态未收敛）。五件套是阻止这类失败的结构保险丝。

本章是全文档最重的一章——Compensator Engine 是 Cairn 的核心 IP。

### 5.1 CompensatorEngine 主类

```ts
// src/reverter/engine.ts
import type {
  LaneId, CompensationPlan, CompensationStep, Receipt, StepResult,
  StepError, StepState, StepEvent, LaneState, LaneEvent, PlanAction,
  BeforeImage, RevertContext, Op, Compensation,
} from '../types';
import type { CheckpointSaver } from '../storage/saver';
import { checkInvariant } from './invariant';
import { buildOptLockHeaders, verifyOptLockResponse } from './optlock';
import { deriveIdempotencyKey } from './idempotency';
import { transitionStep, transitionLane } from './state-machine';
import { buildReceipt } from './receipt';

export class CompensatorEngine {
  constructor(
    private saver: CheckpointSaver,
    private httpForwarder: (req: any) => Promise<any>,
  ) {}

  async executeRevert(laneId: LaneId, opts: { dryRun: boolean; resume?: boolean }): Promise<Receipt> {
    const lock = await this.acquireLaneLock(laneId);
    try {
      await this.freezeLanes([laneId]);
      const plan = await this.planCompensations(laneId);
      const ctx: RevertContext = {
        laneId, dryRun: opts.dryRun, startedAt: new Date().toISOString(),
        completed: [], failed: null, irreversibleTail: [],
      };

      for (const step of plan.steps) {
        if (opts.resume && step.state === 'SUCCESS') { ctx.completed.push(this.resurrectResult(step)); continue; }

        // 1) Invariant check：forward 改过的字段必须被覆盖
        const forwardOp = await this.saver.getOp(step.opId);
        const invRes = checkInvariant(forwardOp, plan, step);
        if (!invRes.ok) {
          ctx.failed = { opId: step.opId, stepIdx: step.stepIdx,
            code: 'INCOMPLETE_BEFORE_IMAGE', msg: invRes.error.message, gaps: invRes.error.gaps };
          break;
        }

        // 2) Execute single step (with optimistic lock + idempotency baked in)
        const result = await this.executeStep(step, ctx);
        if (result.status === 'SUCCESS') {
          ctx.completed.push(result);
          await this.saver.updateCompensationState(step.id,
            transitionStep(step.state, { kind: 'EXIT_0' }),
            { endedAt: Date.now() });
        } else {
          ctx.failed = { opId: step.opId, stepIdx: step.stepIdx,
            code: result.errorCode, msg: result.errorMsg };
          const action = this.handleStepFailure(result.errorCode, step, plan);
          if (action === 'ABORT') break;
          if (action === 'RETRY') { /* retry loop inside executeStep */ }
        }
      }

      // Gather irreversible tail evidence
      ctx.irreversibleTail = await this.gatherIrreversibleTail(plan);

      // Transition lane state
      const newLaneState: LaneState = ctx.failed
        ? 'PARTIAL_REVERT'
        : (ctx.completed.length === plan.steps.length ? 'REVERTED' : 'PARTIAL_REVERT');
      await this.saver.updateLaneState(laneId, newLaneState);
      if (newLaneState === 'PARTIAL_REVERT') {
        await this.saver.markLanePartialRevert(laneId, ctx.failed?.msg ?? 'incomplete');
      }

      const receipt = buildReceipt(laneId, ctx, plan);
      await this.saver.saveReceipt(receipt);
      return receipt;
    } finally {
      await this.releaseLaneLock(lock);
    }
  }

  private async acquireLaneLock(laneId: LaneId): Promise<LaneLock> {
    // r1: holder 是字符串；用 `${pid}@${hostname}` 在 multi-proc 下唯一
    const holder = `${process.pid}@${require('node:os').hostname()}`;
    const ok = await this.saver.tryAcquireLaneLock(laneId, holder, 60_000);
    if (!ok) throw new CairnError('LANE_BUSY', { laneId, holder });
    return { laneId, holder, pid: process.pid };
  }

  private async releaseLaneLock(lock: LaneLock): Promise<void> {
    await this.saver.releaseLaneLock(lock.laneId, lock.holder);
  }

  private async freezeLanes(except: LaneId[]): Promise<void> {
    // Preview: single-process daemon，用内存 Set；v0.1 跨进程用 SQLite `lanes.frozen` flag
    frozenLanes.clear();
    const all = await this.saver.listLanes({});
    for (const l of all) {
      if (except.includes(l.id)) continue;
      frozenLanes.add(l.id);
    }
  }

  private async planCompensations(laneId: LaneId): Promise<CompensationPlan> {
    const ops = await this.saver.getOpsByLane(laneId);
    const steps: CompensationStep[] = [];
    // reverse-order：后发的先 undo
    for (const op of ops.slice().reverse()) {
      if (op.classification === '①' || op.classification === '②') continue;
      const comps = await this.saver.listCompensationsByOp(op.id);
      for (const c of comps) {
        steps.push(this.toStep(op, c));
      }
    }
    return { laneId, steps };
  }

  private toStep(op: Op, c: Compensation): CompensationStep {
    return {
      id: c.id, opId: op.id, stepIdx: c.stepIdx,
      action: c.action, plan: c.plan, state: c.state,
      attempt: c.attempt, covers: c.plan.covers ?? [],
    };
  }

  private async executeStep(step: CompensationStep, ctx: RevertContext): Promise<StepResult> {
    if (ctx.dryRun) return this.simulateStep(step);

    const maxAttempts = 3;
    let lastErr: StepError | null = null;

    for (let attempt = step.attempt + 1; attempt <= maxAttempts; attempt++) {
      await this.saver.updateCompensationState(step.id, 'RUNNING', { attempt, startedAt: Date.now() });

      // r1: 发出前强制二次模板解析（第一次是 Recorder 里的初步绑定）
      // ResolutionContext 从持久化字段重建，支持 --resume 重启续跑
      const forwardOp = await this.saver.getOp(step.opId);
      const resolver = new TemplateResolver({
        path: extractPathVars(forwardOp.manifestSnapshot!.path, forwardOp.urlPath) ?? {},
        request: safeJson(forwardOp.requestBody) as Record<string, unknown> | undefined,
        response: forwardOp.responseStatus ? (safeJson(forwardOp.responseBody) as any) : undefined,
        before_image: forwardOp.beforeImage
          ? { ...(forwardOp.beforeImage.body as Record<string, unknown>), etag: forwardOp.beforeImage.etag }
          : undefined,
      });
      let resolvedUrl: string, resolvedBody: unknown | undefined;
      try {
        resolvedUrl  = resolver.resolve(step.plan.url);
        resolvedBody = step.plan.body != null ? resolver.resolve(step.plan.body as any) : undefined;
      } catch (e: any) {
        if (e.code === 'UNRESOLVED_PLACEHOLDER') {
          return { status: 'FAIL', errorCode: 'INCOMPLETE_BEFORE_IMAGE',
                   errorMsg: `template placeholder unresolved: ${e.details.placeholder}`, step };
        }
        throw e;
      }

      // r1: field-match 乐观锁在发 compensator 前做 probe；etag / version-check 的 pre-flight 是 no-op
      if (step.plan.optimisticLock) {
        const preflight = await executeOptLock(step.plan.optimisticLock, resolver, this.httpForwarder);
        if (preflight.status !== 'ok') {
          await this.saver.updateCompensationState(step.id, 'VERIFY_MISMATCH',
            { lastError: JSON.stringify(preflight) });
          return { status: 'FAIL', errorCode: 'CONFLICT',
                   errorMsg: `optimistic lock preflight: ${preflight.status} ${('detail' in preflight) ? preflight.detail : ''}`,
                   step };
        }
      }

      const idemKey = deriveIdempotencyKey(ctx.laneId, step.stepIdx, step.opId);
      const headers = {
        ...buildOptLockHeaders(step, resolver),
        'Idempotency-Key': idemKey,
        'x-cairn-revert': '1',
      };
      try {
        const resp = await this.httpForwarder({
          method: step.plan.method,
          url: resolvedUrl,
          headers,
          body: resolvedBody != null ? JSON.stringify(resolvedBody) : undefined,
        });
        if (resp.status === 412) {
          lastErr = { code: 'CONFLICT', msg: 'optimistic lock failed', attempt };
          await this.saver.updateCompensationState(step.id, 'VERIFY_MISMATCH', { lastError: JSON.stringify(lastErr) });
          return { status: 'FAIL', errorCode: 'CONFLICT', errorMsg: 'optimistic lock 412', step };
        }
        if (resp.status >= 500 || resp.status === 429) {
          lastErr = { code: 'INFRA_ERR', msg: `status ${resp.status}`, attempt };
          await this.saver.updateCompensationState(step.id, 'INFRA_ERR', { lastError: JSON.stringify(lastErr) });
          if (attempt < maxAttempts) { await this.backoff(attempt); continue; }
          return { status: 'FAIL', errorCode: 'INFRA_ERR', errorMsg: lastErr.msg, step };
        }
        if (resp.status >= 400) {
          return { status: 'FAIL', errorCode: 'INFRA_ERR', errorMsg: `4xx status ${resp.status}`, step };
        }
        const verified = verifyOptLockResponse(resp, step);
        if (!verified) {
          return { status: 'FAIL', errorCode: 'CONFLICT', errorMsg: 'post-compensation verify failed', step };
        }
        return { status: 'SUCCESS', step, at: new Date().toISOString() };
      } catch (err: any) {
        lastErr = { code: 'INFRA_ERR', msg: err.message ?? String(err), attempt };
        if (attempt < maxAttempts) { await this.backoff(attempt); continue; }
        return { status: 'FAIL', errorCode: 'INFRA_ERR', errorMsg: lastErr.msg, step };
      }
    }
    return { status: 'FAIL', errorCode: 'INFRA_ERR', errorMsg: 'max attempts', step };
  }

  private simulateStep(step: CompensationStep): StepResult {
    return { status: 'SUCCESS', step, at: new Date().toISOString(), dryRun: true };
  }

  private async backoff(attempt: number): Promise<void> {
    const ms = Math.min(200 * Math.pow(2, attempt - 1), 2000) + Math.random() * 50;
    await new Promise(r => setTimeout(r, ms));
  }

  private resurrectResult(step: CompensationStep): StepResult {
    return { status: 'SUCCESS', step, at: 'resumed', dryRun: false };
  }

  private handleStepFailure(code: string, step: CompensationStep, plan: CompensationPlan): PlanAction {
    if (code === 'CONFLICT') return 'ABORT';
    if (code === 'INCOMPLETE_BEFORE_IMAGE') return 'ABORT';
    if (code === 'INFRA_ERR') return 'ABORT'; // Preview: don't skip ahead, fail fast
    return 'ABORT';
  }

  private async gatherIrreversibleTail(plan: CompensationPlan): Promise<IrreversibleSideEffect[]> {
    const tail: IrreversibleSideEffect[] = [];
    for (const step of plan.steps) {
      const op = await this.saver.getOp(step.opId);
      // r1: 使用持久化的 classifierResult（SQLite classifier_result_json 列），不再依赖 in-memory 缓存
      // 保证 Cairn kill -9 后 `cairn revert --resume` 仍能枚举 irreversible tail
      const cr = op!.classifierResult ?? op!.classifierResultCache; // 两个别名，后者仅为兼容
      for (const t of cr?.entry?.undoStrategy?.unreversibleTail ?? []) {
        tail.push({ kind: t.kind, detectable: t.detectable, via: t.via, evidence: null });
      }
    }
    return tail;
  }
}

const frozenLanes = new Set<LaneId>();
export function isLaneFrozen(laneId: LaneId): boolean { return frozenLanes.has(laneId); }
```

### 5.2 五件套 #1：Invariant check

forward 请求修改过的每个字段，compensator chain 执行完后必须逐字段被覆盖。实现比对 `op.forward.requestBody` 的 JSON paths 集合 vs `compensation.steps[].covers` 集合，差集非空即抛 `INCOMPLETE_BEFORE_IMAGE`。

```ts
// src/reverter/invariant.ts
import type { Op, CompensationPlan, CompensationStep, InvariantError } from '../types';

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/** 从 forward request body 抽出 mutated JSON paths（顶层字段级别，Preview 不做嵌套 diff） */
export function extractMutatedPaths(reqBody: unknown, beforeImage: unknown): string[] {
  if (reqBody == null) return [];
  const body = typeof reqBody === 'string' ? safeJson(reqBody) : reqBody;
  if (body == null || typeof body !== 'object') return [];
  const before = (beforeImage ?? {}) as Record<string, unknown>;
  const paths: string[] = [];
  for (const k of Object.keys(body)) {
    if (!deepEqual(before[k], (body as any)[k])) paths.push(k);
  }
  return paths;
}

export function checkInvariant(
  op: Op,
  plan: CompensationPlan,
  currentStep: CompensationStep,
): Result<void, InvariantError & { gaps: string[] }> {
  const mutated = extractMutatedPaths(op.requestBody, op.beforeImage);
  const coveredByAnyStep = new Set<string>();
  for (const s of plan.steps) {
    if (s.opId !== op.id) continue;
    for (const c of s.covers ?? []) coveredByAnyStep.add(c);
  }
  const coverageGaps: string[] = (op.manifestSnapshot?.beforeImage.coverageGaps ?? []).map(g => g.field);
  const acceptableGap = new Set(coverageGaps);
  const gaps = mutated.filter(p => !coveredByAnyStep.has(p) && !acceptableGap.has(p));
  if (gaps.length > 0) {
    return { ok: false, error: {
      kind: 'INCOMPLETE_BEFORE_IMAGE', opId: op.id, gaps,
      message: `compensator chain does not cover mutated fields: ${gaps.join(', ')}`,
    }};
  }
  return { ok: true, value: undefined };
}

function safeJson(s: string): unknown { try { return JSON.parse(s); } catch { return null; } }
function deepEqual(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
```

### 5.3 五件套 #2：Optimistic lock

每 step 的 compensator 请求带 `If-Match: <forward-etag>` 或 `WHERE field = forwardValue`。响应 `412 Precondition Failed` / `changes=0` → 标 `CONFLICT`，**不静默覆盖**。GitHub 的 PR / comment / issue 都有 ETag；创建/删除类不需要乐观锁（幂等即可）。

```ts
// src/reverter/optlock.ts  (r1: 三型乐观锁统一实现)
import type { CompensationStep, OptLockSpec, OptLockResult } from '../types';
import type { TemplateResolver } from './template';

/** Pre-flight: 在 compensator 发出前置 header 或做 probe */
export function buildOptLockHeaders(step: CompensationStep, resolver: TemplateResolver): Record<string, string> {
  const lock = step.plan.optimisticLock;
  if (!lock) return {};
  if (lock.type === 'etag')          return { 'If-Match': resolver.resolve(lock.value) };
  if (lock.type === 'version-check') return {};   // 不走 header，走响应时比对
  if (lock.type === 'field-match')   return {};   // 不走 header，发出前先 probe（executeFieldMatch）
  return {};
}

/**
 * r1: 执行 optimistic lock 的前置验证。
 * etag / version-check 走 header / in-response 对比；field-match 走 probe。
 * 返回 'ok' / 'conflict' / 'probe_failed'。
 */
export async function executeOptLock(
  spec: OptLockSpec,
  resolver: TemplateResolver,
  httpForwarder: (req: any) => Promise<any>,
): Promise<OptLockResult> {
  switch (spec.type) {
    case 'etag':          return { status: 'ok' }; // header 层交给 buildOptLockHeaders，412 在响应判定
    case 'version-check': return { status: 'ok' }; // 发出后 verifyOptLockResponse 判定
    case 'field-match':   return executeFieldMatch(spec, resolver, httpForwarder);
    default:              throw new Error(`Unsupported optimistic lock type: ${(spec as any).type}`);
  }
}

async function executeFieldMatch(
  spec: Extract<OptLockSpec, { type: 'field-match' }>,
  resolver: TemplateResolver,
  httpForwarder: (req: any) => Promise<any>,
): Promise<OptLockResult> {
  const probeUrlRaw = spec.probe_url.startsWith('GET ') ? spec.probe_url.slice(4) : spec.probe_url;
  const probeUrl = resolver.resolve(probeUrlRaw) as string;
  const compareValue = resolver.resolve(spec.compare_value) as string;

  const resp = await httpForwarder({ method: 'GET', url: probeUrl, headers: {} });
  if (resp.status < 200 || resp.status >= 300) {
    return { status: 'probe_failed', httpStatus: resp.status };
  }
  const body = typeof resp.body === 'string' ? safeJson(resp.body) : resp.body;
  const match = checkCompareStrategy(body, spec.compare_strategy, compareValue);
  return match ? { status: 'ok' }
               : { status: 'conflict', detail: `field drift: expected "${compareValue}" by strategy=${spec.compare_strategy}` };
}

function checkCompareStrategy(body: unknown, strategy: string, value: string): boolean {
  switch (strategy) {
    case 'must_contain':
      // 针对 label 列表类：body 是 array of { name: string }，value 要出现在里面
      if (!Array.isArray(body)) return false;
      return body.some(item => item && typeof item === 'object' && 'name' in (item as any) && (item as any).name === value);
    case 'must_not_contain':
      if (!Array.isArray(body)) return true;
      return !body.some(item => item && typeof item === 'object' && 'name' in (item as any) && (item as any).name === value);
    case 'exact_match':
      return JSON.stringify(body) === JSON.stringify(value);
    default:
      throw new Error(`Unknown compare_strategy: ${strategy}`);
  }
}

function safeJson(s: string): unknown { try { return JSON.parse(s); } catch { return null; } }

/**
 * r1: 发出 compensator 后按 spec.type 走分支验证。不再把任何 2xx 当万能 OK。
 */
export function verifyOptLockResponse(
  resp: { status: number; headers: Headers | Record<string, string>; body?: any },
  step: CompensationStep,
): boolean {
  const lock = step.plan.optimisticLock;
  // 无锁：只做 HTTP status 基本判定
  if (!lock) return resp.status === 204 || (resp.status >= 200 && resp.status < 300);

  switch (lock.type) {
    case 'etag':
      if (resp.status === 412) return false;          // 上游直接拒
      if (resp.status === 204) return true;           // DELETE 成功
      return resp.status >= 200 && resp.status < 300;
    case 'version-check': {
      // 发出后的响应应带新版本；在此只做 HTTP 健康判定，具体 field 比对由调用侧在 executeStep 里做
      return resp.status >= 200 && resp.status < 300;
    }
    case 'field-match':
      // field-match 的真实验证已经在 executeFieldMatch 里完成（发出前 probe）
      // 这里只需确认 compensator 请求本身 HTTP 层没炸
      return resp.status === 204 || (resp.status >= 200 && resp.status < 300);
    default:
      return false;
  }
}
```

**调用点变化**：`executeStep` 在发出 compensator HTTP 请求**前**调一次 `executeOptLock`（field-match 才会真干活），拿到 `conflict` 就 abort；HTTP 响应回来后再 `verifyOptLockResponse` 兜一次。两处组合起来让 "2xx 万能 OK" 的 bug 被堵死。

### 5.4 五件套 #3：Idempotency

每 step 注入派生 key：`idempotencyKey = sha256(`${laneId}:${stepIdx}:${opId}`)`。GitHub 原生不认 `Idempotency-Key`，所以在 **revert step 级别** 做本地幂等：`compensations` 表的 `(lane_id, step_idx, attempt)` 做 unique；重跑时先查，已 SUCCESS 的直接跳过。

```ts
// src/reverter/idempotency.ts
import { createHash } from 'node:crypto';

export function deriveIdempotencyKey(laneId: string, stepIdx: number, opId: string): string {
  const h = createHash('sha256').update(`${laneId}:${stepIdx}:${opId}`).digest('hex');
  return h.slice(0, 32);
}

/** 调用方 cache：(laneId,stepIdx,action) 已 SUCCESS 则不再发出 */
export async function wasAlreadySuccessful(
  saver: { listCompensationsByOp(opId: string): Promise<{ state: string; stepIdx: number; action: string }[]> },
  opId: string, stepIdx: number, action: string,
): Promise<boolean> {
  const comps = await saver.listCompensationsByOp(opId);
  return comps.some(c => c.stepIdx === stepIdx && c.action === action && c.state === 'SUCCESS');
}
```

### 5.5 五件套 #4：两级状态机

完整机器见 `D:\lll\cairn\cairn-poc\compensator\FAULT_INJECTION\STATE_MACHINE.txt`，Preview 直接实现该文件里的转移表。

```ts
// src/reverter/state-machine.ts
import type { StepState, StepEvent, LaneState, LaneEvent } from '../types';

/** Per-step 状态机 */
export function transitionStep(state: StepState, event: StepEvent): StepState {
  switch (state) {
    case 'PENDING':
      switch (event.kind) {
        case 'START': return 'RUNNING';
        default: return state;
      }
    case 'RUNNING':
      switch (event.kind) {
        case 'EXIT_0': return 'SUCCESS';
        case 'EXIT_2': return 'PARTIAL';
        case 'EXIT_3': return 'VERIFY_MISMATCH';
        case 'EXIT_4': return 'INFRA_ERR';
        case 'EXIT_5': return 'MANUAL_GATE';
        default: return state;
      }
    case 'INFRA_ERR':
      switch (event.kind) {
        case 'RETRY': return 'RUNNING';
        case 'ABANDON': return 'PARTIAL';
        default: return state;
      }
    case 'SUCCESS':
    case 'PARTIAL':
    case 'VERIFY_MISMATCH':
    case 'MANUAL_GATE':
      return state; // terminal
    default:
      return state;
  }
}

/** Per-lane 状态机 */
export function transitionLane(state: LaneState, event: LaneEvent): LaneState {
  switch (state) {
    case 'RECORDED':
      switch (event.kind) {
        case 'REVERT_START': return 'REVERTING';
        default: return state;
      }
    case 'REVERTING':
      switch (event.kind) {
        case 'ALL_SUCCESS': return 'REVERTED';
        case 'ANY_FAIL': return 'PARTIAL_REVERT';
        case 'INFRA_EXHAUSTED': return 'FAILED_RETRYABLE';
        case 'MANUAL_GATE': return 'HELD_FOR_HUMAN';
        default: return state;
      }
    case 'FAILED_RETRYABLE':
      switch (event.kind) {
        case 'REVERT_START': return 'REVERTING';
        default: return state;
      }
    case 'HELD_FOR_HUMAN':
      switch (event.kind) {
        case 'APPROVE': return 'REVERTING';
        case 'DENY': return 'PARTIAL_REVERT';
        default: return state;
      }
    case 'REVERTED':
    case 'PARTIAL_REVERT':
      return state; // terminal
    default:
      return state;
  }
}

/** Exit code 映射，CLI / receipt / 外部脚本都绑定 */
export function exitCodeForReceipt(receipt: { exitCode: number }): number {
  return receipt.exitCode;
}

/** Lane 终态 → CLI exit code（**只覆盖 0 / 2 / 4 / 5；exit code 3 由 failed[].code 决定，见下**） */
export function laneStateToExitCode(state: LaneState, hasIrreversibleTail: boolean): 0 | 2 | 4 | 5 {
  switch (state) {
    case 'REVERTED': return 0; // irreversibleTail 通过 receipt.irreversibleSideEffects 告知
    case 'PARTIAL_REVERT': return 2;
    case 'FAILED_RETRYABLE': return 4;
    case 'HELD_FOR_HUMAN': return 5;
    default: return 2;
  }
}

/** 人类可读字符串映射（CLI 输出 / receipt 展示使用；**不要**把字符串写回 Receipt） */
export function exitCodeToString(code: 0 | 2 | 3 | 4 | 5): string {
  switch (code) {
    case 0: return 'SUCCESS';
    case 2: return 'PARTIAL_UNDO';
    case 3: return 'VERIFY_MISMATCH';
    case 4: return 'INFRA_ERR';
    case 5: return 'MANUAL_GATE';
  }
}
```

**两层映射契约**（Engine 与 CLI 的职责划分）：

Engine 只产出 `Receipt`，**不**直接决定进程退出码；进程退出码由 CLI 层推导。推导规则：

1. 若 `receipt.failed.length === 0` → 由 `laneStateToExitCode(lane.state)` 决定（`0 / 2 / 4 / 5`）
2. 若 `receipt.failed.length > 0` → 取 `receipt.failed[0].code` 映射（`VERIFY_MISMATCH → 3` / `INFRA_ERR → 4` / `MANUAL_GATE → 5` / 其他 → 2），**优先级高于 lane state**

**Exit code 硬契约**：

| code | 含义 | 来源 |
|---|---|---|
| 0 | SUCCESS — 全部 reversible 部分已 confirm 收敛 | `laneStateToExitCode(REVERTED)` |
| 2 | PARTIAL_UNDO — 部分 step 成功、部分失败，receipt 有完整枚举 | `laneStateToExitCode(PARTIAL_REVERT)` 或 `failed[0].code` 不在下表时 |
| 3 | VERIFY_MISMATCH — optimistic lock 未通过 / invariant check 失败 | **仅** `failed[0].code ∈ {CONFLICT, INCOMPLETE_BEFORE_IMAGE}` |
| 4 | INFRA_ERR — 网络/5xx/超时，可重跑 | `laneStateToExitCode(FAILED_RETRYABLE)` 或 `failed[0].code === 'INFRA_ERR'` |
| 5 | MANUAL_GATE — 碰到 irreversible tail 或 approval 未批 | `laneStateToExitCode(HELD_FOR_HUMAN)` 或 `failed[0].code === 'MANUAL_GATE'` |

**CLI `process.exit` 映射**（统一用 helper，不写散落 if/else）：

```ts
// src/cli/revert.ts 片段
import { laneStateToExitCode, deriveExitCode } from '../reverter/exit-code';

const receipt = await engine.executeRevert(laneId, { dryRun });
const lane = await store.getLane(laneId);
const code = deriveProcessExitCode(receipt, lane);
process.exit(code);

// src/reverter/exit-code.ts
export function deriveProcessExitCode(receipt: Receipt, lane: Lane): 0 | 2 | 3 | 4 | 5 {
  if (receipt.failed.length > 0) {
    return deriveExitCode(receipt.failed[0].code);
  }
  return laneStateToExitCode(lane.state, receipt.irreversibleSideEffects.length > 0);
}
```

### 5.6 五件套 #5：Structured receipt

```ts
// src/reverter/receipt.ts
import type { Receipt, CompensationPlan, RevertContext, LaneId } from '../types';

export function buildReceipt(
  lane: Lane,                    // 完整 Lane 而非只有 laneId，用于 denormalize agent 上下文
  ctx: RevertContext,
  plan: CompensationPlan,
): Receipt {
  const reverted = ctx.completed.map(r => ({
    opId: r.step.opId,
    stepIdx: r.step.stepIdx,
    covers: r.step.covers,
    at: r.at,
  }));
  const failed = ctx.failed ? [{
    opId: ctx.failed.opId,
    stepIdx: ctx.failed.stepIdx,
    code: ctx.failed.code,
    msg: ctx.failed.msg,
    gaps: ctx.failed.gaps,
  }] : [];
  const ended = new Date().toISOString();
  return {
    // Lane 上下文（denormalized）
    laneId: lane.id,
    agentId: lane.agentId,
    agentName: lane.agentName,
    pipelineId: lane.pipelineId,

    // 状态
    exitCode: failed.length === 0 ? 0 : deriveExitCode(failed[0].code),
    reverted,
    failed,
    irreversibleSideEffects: ctx.irreversibleTail,

    // 元数据
    timings: {
      startedAt: ctx.startedAt,
      endedAt: ended,
      wallMs: new Date(ended).getTime() - new Date(ctx.startedAt).getTime(),
    },
    attribution: { confidence: ctx.attributionConfidence ?? 'high' },
    engineVersion: `cairn/${ENGINE_VERSION}`,
    generatedAt: Date.now(),
  };
}

/** 从 failed[0].code 推导 exit code。用于 CLI 层的 deriveProcessExitCode */
export function deriveExitCode(code: string): 2 | 3 | 4 | 5 {
  if (code === 'CONFLICT' || code === 'INCOMPLETE_BEFORE_IMAGE') return 3;
  if (code === 'INFRA_ERR') return 4;
  if (code === 'MANUAL_GATE') return 5;
  return 2;
}
```

`reverted[]` 与 `irreversibleSideEffects[]` **严格不重叠**——同一副作用不能既算撤回又算 irreversible，要么这边要么那边。CLI 和 JSON 输出都展这俩数组；前端（未来的 Web UI）对 `irreversibleSideEffects` 非空的 revert 展醒目警告。

### 5.7 Before-image 实现

每个 ③ op 进站时：

```ts
// src/reverter/before-image.ts
import type { ManifestEntry, BeforeImage, ParsedRequest } from '../types';
import { extractPathVars } from '../classifier/path-match';

export async function captureBeforeImage(
  entry: ManifestEntry,
  req: ParsedRequest,
  upstreamFetch: (url: string, init?: RequestInit) => Promise<Response>,
  budgetMs: number,
): Promise<BeforeImage | null> {
  if (!entry.beforeImage.captureVia) return null;
  const vars = extractPathVars(entry.path, req.urlPath) ?? {};
  const captureTemplate = entry.beforeImage.captureVia.replace(/^GET\s+/, '');
  const url = Object.entries(vars).reduce(
    (u, [k, v]) => u.replace(`{${k}}`, v),
    captureTemplate,
  );
  const fullUrl = new URL(url, req.upstreamBase).toString();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  try {
    const resp = await upstreamFetch(fullUrl, {
      method: 'GET',
      headers: { 'Authorization': req.headers['authorization'] ?? '', 'Accept': 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`BEFORE_IMAGE_HTTP_${resp.status}`);
    const body = await resp.json();
    const etag = resp.headers.get('etag') ?? undefined;
    return applyCoverageGaps({ fetchedAt: Date.now(), body, etag }, entry.beforeImage.coverageGaps.map(g => g.field));
  } catch (e: any) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new CairnError('BEFORE_IMAGE_TIMEOUT', { url: fullUrl, budgetMs });
    throw new CairnError('BEFORE_IMAGE_UNAVAILABLE', { url: fullUrl, cause: e.message });
  }
}

export function applyCoverageGaps(image: BeforeImage, gaps: string[]): BeforeImage {
  const body = { ...(image.body as Record<string, unknown>) };
  for (const g of gaps) delete body[g];
  return { ...image, body, coverageGaps: gaps };
}
```

POC 数据：Preview 阶段本地 mock **P50 +34-45ms**，真实 GitHub API 在 sandbox repo 测得 **100-400ms**，manifest `extra_latency_budget_ms` 设为 500ms 保守兜底。

### 5.8 Partial-revert 冻结

任一 step 失败 → 整 lane 进入 `PARTIAL_REVERT`，三件事自动发生：

```ts
// src/reverter/engine.ts（接上 executeRevert 的尾部）

private async emitPartialRevertReceipt(
  laneId: LaneId, completed: StepResult[], failed: StepResult,
): Promise<Receipt> {
  // 1) SQLite lanes.state UPDATE 为 PARTIAL_REVERT + frozen=1
  await this.saver.updateLaneState(laneId, 'PARTIAL_REVERT');
  await this.saver.markLanePartialRevert(laneId, failed.errorMsg);

  // 2) proxy 对该 lane 新入站 op 返回 409
  frozenLanes.add(laneId);

  // 3) 构造 receipt
  return buildReceipt(laneId, {
    laneId, startedAt: new Date(Date.now() - 1).toISOString(),
    completed, failed: { opId: failed.step.opId, stepIdx: failed.step.stepIdx,
                         code: failed.errorCode as any, msg: failed.errorMsg },
    irreversibleTail: [], dryRun: false,
  } as any, { laneId, steps: [] });
}
```

CLI `cairn status` 顶部对 frozen lane 打红条；`cairn revert <lane>` 再跑会先做 **dry-run diff**，确认剩余 step 无 conflict 再继续。

### 5.9 故障处理路径（对应 3 个 fault injection 场景）

```ts
// 故障决策
handleStepFailure(err, step, plan):
  - INCOMPLETE_BEFORE_IMAGE → ABORT，整 lane PARTIAL_REVERT
  - CONFLICT (412)          → ABORT，整 lane PARTIAL_REVERT，建议用户 `cairn revert --dry-run` 再诊
  - INFRA_ERR（5xx/timeout）→ in-step 重试 3 次 + 指数退避；仍然失败 → ABORT
  - MANUAL_GATE              → 不消失，等下一轮 `cairn approve`
```

**三个 fault injection 测试骨架**（tests/fault/）：

```ts
// tests/fault/F-invariant.test.ts
import { test, expect } from 'bun:test';
import { startMockGithub, startCairn, runLane, stop } from '../helpers';

test('F-invariant: compensator chain misses a mutated field → exit 3', async () => {
  // Arrange
  const gh = await startMockGithub({ port: 18110 });
  const cairn = await startCairn({ proxyPort: 7778, githubBase: gh.url });
  const op = await runLane(cairn, 'PATCH', '/repos/x/y/pulls/1',
                           { title: 'new', body: 'new body' });

  // Act: 污染 manifest，让 compensator 只恢复 title
  cairn.patchManifestForTest(m => {
    const entry = m.entries.find(e => e.path === '/repos/{owner}/{repo}/pulls/{number}' && e.method === 'PATCH')!;
    entry.undoStrategy.compensatorChain[0].covers = ['title']; // drop 'body'
  });
  const receipt = await cairn.revert(op.laneId);

  // Assert
  expect(receipt.exitCode).toBe(3);
  expect(receipt.failed[0].code).toBe('INCOMPLETE_BEFORE_IMAGE');
  expect(receipt.failed[0].gaps).toContain('body');

  await stop(cairn, gh);
});
```

```ts
// tests/fault/F-optlock.test.ts
test('F-optlock: third-party modifies resource mid-revert → 412 → CONFLICT', async () => {
  const gh = await startMockGithub({ port: 18110 });
  const cairn = await startCairn({ proxyPort: 7778, githubBase: gh.url });
  const op = await runLane(cairn, 'PATCH', '/repos/x/y/pulls/1', { state: 'closed' });

  // Mid-revert, bump the resource etag on mock server
  gh.on('PATCH /repos/x/y/pulls/1', (req, res) => {
    if (req.headers['if-match'] !== 'etag-stale-value') {
      res.writeHead(412).end();
    }
  });

  const receipt = await cairn.revert(op.laneId);
  expect(receipt.exitCode).toBe(3);
  expect(receipt.failed[0].code).toBe('CONFLICT');
  await stop(cairn, gh);
});
```

```ts
// tests/fault/F-midstep.test.ts
test('F-midstep: step 2 of 3 fails with 500 → partial-revert + full enumeration', async () => {
  const gh = await startMockGithub({ port: 18110 });
  const cairn = await startCairn({ proxyPort: 7778, githubBase: gh.url });
  const op = await runLane(cairn, 'POST', '/repos/x/y/pulls', { title: 't', head: 'demo', base: 'main' });

  // Arrange: compensator step 0 (close PR) ok, step 1 (delete ref) fails
  gh.respondWith('DELETE /repos/x/y/git/refs/heads/demo', 500);

  const receipt = await cairn.revert(op.laneId);

  expect(receipt.exitCode).toBe(2); // PARTIAL_UNDO
  expect(receipt.reverted).toHaveLength(1); // step 0 got through
  expect(receipt.failed).toHaveLength(1);
  expect(receipt.failed[0].code).toBe('INFRA_ERR');
  await stop(cairn, gh);
});
```

**已知风险 + 应对**
- **multi-step compensation 中途崩溃（Cairn 守护进程 kill -9）**：状态机 + SQLite 原子写，重启后 `cairn revert --resume <lane>` 从 last successful step 继续
- **GitHub API 不返回 ETag 的端点**：`issues/labels` 就没 ETag。manifest 里 `optimistic_lock_strategy: "field-match"`，compensator 用 `GET` 抓当前集合再对比
- **retry 3 次还是失败**：fail fast + 整 lane `PARTIAL_REVERT`，留给用户手动介入

---

## 6. 存储层

### 6.1 SQLite DDL（完整 schema）

`~/.cairn/timeline.sqlite`，四张表：

```sql
-- src/storage/schema.sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS lanes (
  id               TEXT PRIMARY KEY,          -- lane_<ulid>
  pipeline_id      TEXT NOT NULL,
  agent_name       TEXT NOT NULL,
  state            TEXT NOT NULL,             -- RECORDED/REVERTING/REVERTED/PARTIAL_REVERT/HELD/FAILED_RETRYABLE
  frozen           INTEGER NOT NULL DEFAULT 0,
  attribution      TEXT NOT NULL,             -- high|medium|low|none
  mode             TEXT NOT NULL,             -- strict|acceptIrreversible|bypass
  -- r1: holder 字符串（PID / daemon instance UUID），允许 multi-proc CAS；原 lock_pid 保留向下兼容
  lock_pid         INTEGER,                   -- legacy: pre-r1 holder 的 PID
  lock_holder      TEXT,                      -- r1 新增：canonical holder id（pid 或 uuid）
  lock_expires_at  INTEGER,                   -- r1 新增：epoch ms，与 lock_holder 一起做 CAS 判定
  lock_expires     INTEGER,                   -- legacy（向下兼容，同值同步写）
  partial_reason   TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS lanes_pipeline ON lanes(pipeline_id);
CREATE INDEX IF NOT EXISTS lanes_state    ON lanes(state);

CREATE TABLE IF NOT EXISTS ops (
  id                     TEXT PRIMARY KEY,          -- op_<ulid>
  lane_id                TEXT NOT NULL REFERENCES lanes(id) ON DELETE CASCADE,
  seq                    INTEGER NOT NULL,          -- 1,2,3... 该 lane 内的单调序号
  method                 TEXT NOT NULL,
  url                    TEXT NOT NULL,
  url_path               TEXT NOT NULL,             -- normalized path, indexed for lookups
  request_body           BLOB,                      -- 仅 body；完整快照在 request_snapshot_json
  request_snapshot_json  TEXT NOT NULL DEFAULT '{}',-- r1: RequestSnapshot（method/url/headers/body/ts/clientConnId）
  response_status        INTEGER,
  response_body          BLOB,
  before_image           TEXT,                      -- JSON (BeforeImage)
  classification         TEXT NOT NULL,             -- ①/②/③/④
  classifier_result_json TEXT NOT NULL DEFAULT '{}',-- r1: 完整 ClassifierResult 序列化
  state                  TEXT NOT NULL,             -- PENDING_APPROVAL/PASSED/BLOCKED/FAILED
  manifest_snap          TEXT,                      -- 分类时的 manifest entry 快照 JSON
  created_at             INTEGER NOT NULL,
  UNIQUE(lane_id, seq)
);
CREATE INDEX IF NOT EXISTS ops_lane ON ops(lane_id);

CREATE TABLE IF NOT EXISTS compensations (
  id              TEXT PRIMARY KEY,          -- comp_<ulid>
  op_id           TEXT NOT NULL REFERENCES ops(id) ON DELETE CASCADE,
  step_idx        INTEGER NOT NULL,          -- 0,1,2...
  action          TEXT NOT NULL,             -- e.g. "github:delete-ref"
  plan            TEXT NOT NULL,             -- JSON: { method, url, body, covers, optimisticLock, ... }
  state           TEXT NOT NULL,             -- PENDING/RUNNING/SUCCESS/PARTIAL/VERIFY_MISMATCH/INFRA_ERR/MANUAL_GATE
  attempt         INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  started_at      INTEGER,
  ended_at        INTEGER,
  UNIQUE(op_id, step_idx, attempt)
);
CREATE INDEX IF NOT EXISTS comps_op ON compensations(op_id);

CREATE TABLE IF NOT EXISTS receipts (
  lane_id         TEXT PRIMARY KEY REFERENCES lanes(id) ON DELETE CASCADE,
  exit_code       INTEGER NOT NULL,
  payload         TEXT NOT NULL,             -- 完整 JSON Receipt
  created_at      INTEGER NOT NULL
);
```

**WAL 的理由**：proxy 进程 + CLI `cairn revert` 进程可能并发访问。WAL 模式读不阻塞写；写锁竞争由应用层 `tryAcquireLaneLock` 处理。

**写入纪律**：所有 lane/op/compensation state 变更走 **单 transaction**（`BEGIN IMMEDIATE`），保证 "op 落盘 + classification 落盘 + approval gate 状态" 原子。

### 6.2 CheckpointSaver interface

```ts
// src/storage/saver.ts
import type {
  Lane, NewLane, LaneFilter, LaneState,
  Op, NewOp, Compensation, CompensationStepPlan, CompState,
  Receipt, LaneId,
} from '../types';

export interface CheckpointSaver {
  // Lanes
  createLane(lane: Omit<Lane, 'id' | 'createdAt' | 'updatedAt'>): Promise<Lane>;
  getLane(id: LaneId): Promise<Lane | null>;
  listLanes(filter?: LaneFilter): Promise<Lane[]>;
  updateLaneState(id: LaneId, state: LaneState, extra?: Partial<Lane>): Promise<void>;
  markLanePartialRevert(id: LaneId, reason: string): Promise<void>;
  // r1: holder 是字符串（e.g. `${pid}@${hostname}` 或 daemon uuid），允许 multi-proc
  tryAcquireLaneLock(id: LaneId, holder: string, ttlMs: number): Promise<boolean>;
  releaseLaneLock(id: LaneId, holder: string): Promise<void>;

  // Ops
  appendOp(laneId: LaneId, op: Omit<Op, 'id' | 'laneId' | 'seq' | 'createdAt'>): Promise<Op>;
  getOp(opId: string): Promise<Op | null>;
  getOpsByLane(laneId: LaneId): Promise<Op[]>;
  updateOp(opId: string, patch: Partial<Op>): Promise<void>;

  // Compensations
  saveCompensation(c: Omit<Compensation, 'id'>): Promise<Compensation>;
  listCompensationsByOp(opId: string): Promise<Compensation[]>;
  updateCompensationState(id: string, state: CompState, extra?: Partial<Compensation>): Promise<void>;

  // Receipts
  saveReceipt(r: Receipt): Promise<void>;
  getReceipt(laneId: LaneId): Promise<Receipt | null>;

  // Tx helpers (r1 split: sync default, async opt-in)
  withTx<T>(fn: (tx: CheckpointSaver) => T): T;                              // sync (preferred)
  withTxSync<T>(fn: (tx: CheckpointSaver) => T): T;                          // sync (explicit name)
  withTxAsync<T>(fn: (tx: CheckpointSaver) => Promise<T>): Promise<T>;       // async (serialized via mutex)
}

/** 简易互斥锁，供 withTxAsync 串行化；Preview 单进程内使用 */
class AsyncMutex {
  private queue: Array<() => void> = [];
  private locked = false;
  async acquire(): Promise<void> {
    if (!this.locked) { this.locked = true; return; }
    await new Promise<void>(res => this.queue.push(res));
  }
  release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.locked = false;
  }
}
export const appLevelMutex = new AsyncMutex();
```

v0.0.1 Preview 只实现 `SqliteCheckpointSaver`。v0.1 Postgres / v0.3 S3 cold-tier / v0.4 LangGraph `BaseCheckpointSaver` 反向兼容——全部通过实现同一接口接入。**任何 Cairn 业务代码只依赖 `CheckpointSaver`，不直接写 SQL**。

### 6.3 SqliteCheckpointSaver 实现骨架

```ts
// src/storage/sqlite-saver.ts
import { Database } from 'bun:sqlite';
import { ulid } from 'ulid';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckpointSaver } from './saver';
import type { Lane, NewLane, LaneFilter, LaneState, LaneId, Op,
               Compensation, CompState, Receipt } from '../types';

export class SqliteCheckpointSaver implements CheckpointSaver {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.exec(readFileSync(join(import.meta.dir, 'schema.sql'), 'utf8'));
  }

  async createLane(lane: Omit<Lane, 'id' | 'createdAt' | 'updatedAt'>): Promise<Lane> {
    const id = `lane_${ulid()}`;
    const now = Date.now();
    this.db.run(
      `INSERT INTO lanes (id, pipeline_id, agent_name, state, frozen, attribution, mode, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, lane.pipelineId, lane.agentName, lane.state, lane.frozen ? 1 : 0,
       lane.attribution, lane.mode, now, now],
    );
    return { ...lane, id, createdAt: now, updatedAt: now };
  }

  async getLane(id: LaneId): Promise<Lane | null> {
    const row = this.db.query(`SELECT * FROM lanes WHERE id = ?`).get(id) as any;
    return row ? this.rowToLane(row) : null;
  }

  async listLanes(filter: LaneFilter = {}): Promise<Lane[]> {
    const where: string[] = [];
    const params: any[] = [];
    if (filter.pipelineId) { where.push('pipeline_id = ?'); params.push(filter.pipelineId); }
    if (filter.state)      { where.push('state = ?');       params.push(filter.state); }
    const sql = `SELECT * FROM lanes ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`;
    return (this.db.query(sql).all(...params) as any[]).map(r => this.rowToLane(r));
  }

  async updateLaneState(id: LaneId, state: LaneState, extra: Partial<Lane> = {}): Promise<void> {
    const now = Date.now();
    this.db.run(
      `UPDATE lanes SET state = ?, updated_at = ?, frozen = COALESCE(?, frozen)
         WHERE id = ?`,
      [state, now, extra.frozen != null ? (extra.frozen ? 1 : 0) : null, id],
    );
  }

  async markLanePartialRevert(id: LaneId, reason: string): Promise<void> {
    this.db.run(`UPDATE lanes SET state='PARTIAL_REVERT', frozen=1, partial_reason=?, updated_at=? WHERE id=?`,
                [reason, Date.now(), id]);
  }

  /**
   * r1: Atomic compare-and-set lane lock.
   *
   * 旧实现（SELECT → UPDATE 两步）有 TOCTOU：两进程并发均 SELECT 看到 NULL，双方 UPDATE 全成功、双方都以为自己持锁。
   * r1 用单条 UPDATE 条件过滤（holder IS NULL OR 过期），changes===0 则拿不到锁。
   * holder 传入字符串（推荐 `${pid}@${hostname}` 或 daemon uuid），兼容跨进程场景。
   */
  async tryAcquireLaneLock(id: LaneId, holder: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const expiresAt = now + ttlMs;
    const result = this.db.run(
      `UPDATE lanes
         SET lock_holder = ?, lock_expires_at = ?,
             lock_pid = ?, lock_expires = ?   -- legacy 列同步写，向下兼容
       WHERE id = ?
         AND (lock_holder IS NULL OR lock_expires_at < ? OR lock_holder = ?)`,
      [holder, expiresAt,
       Number.isInteger(Number(holder)) ? Number(holder) : null, expiresAt,
       id, now, holder],
    );
    return (result as any).changes > 0;
  }

  async releaseLaneLock(id: LaneId, holder: string): Promise<void> {
    // 只允许当前 holder 自己释放
    this.db.run(
      `UPDATE lanes
         SET lock_holder = NULL, lock_expires_at = NULL, lock_pid = NULL, lock_expires = NULL
       WHERE id = ? AND lock_holder = ?`,
      [id, holder],
    );
  }

  async appendOp(laneId: LaneId, op: any): Promise<Op> {
    const id = `op_${ulid()}`;
    const now = Date.now();
    // r1: bun:sqlite transaction 必须是 sync 回调；此函数内无 async I/O，OK 包在 sync tx 里
    const tx = this.db.transaction(() => {
      const maxSeq = (this.db.query(`SELECT COALESCE(MAX(seq),0) AS m FROM ops WHERE lane_id = ?`).get(laneId) as any).m;
      const seq = maxSeq + 1;
      this.db.run(
        `INSERT INTO ops (id, lane_id, seq, method, url, url_path, request_body,
                          request_snapshot_json, response_status, response_body,
                          before_image, classification, classifier_result_json,
                          state, manifest_snap, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, laneId, seq, op.method, op.url, op.urlPath ?? op.url,
         op.requestBody ?? null,
         JSON.stringify(op.requestSnapshot ?? {}),                           // r1: RequestSnapshot
         op.responseStatus ?? null, op.responseBody ?? null,
         op.beforeImage ? JSON.stringify(op.beforeImage) : null,
         op.classification,
         JSON.stringify(op.classifierResult ?? op.classifierResultCache ?? {}), // r1: full ClassifierResult
         op.state,
         op.manifestSnapshot ? JSON.stringify(op.manifestSnapshot) : null,
         now],
      );
      this.db.run(`UPDATE lanes SET updated_at = ? WHERE id = ?`, [now, laneId]);
      return { ...op, id, laneId, seq, createdAt: now } as Op;
    });
    return tx();
  }

  async getOp(opId: string): Promise<Op | null> {
    const row = this.db.query(`SELECT * FROM ops WHERE id = ?`).get(opId) as any;
    return row ? this.rowToOp(row) : null;
  }

  async getOpsByLane(laneId: LaneId): Promise<Op[]> {
    const rows = this.db.query(`SELECT * FROM ops WHERE lane_id = ? ORDER BY seq ASC`).all(laneId) as any[];
    return rows.map(r => this.rowToOp(r));
  }

  async updateOp(opId: string, patch: Partial<Op>): Promise<void> {
    const sets: string[] = [];
    const vals: any[] = [];
    if (patch.responseStatus != null) { sets.push('response_status = ?'); vals.push(patch.responseStatus); }
    if (patch.responseBody != null)   { sets.push('response_body = ?');   vals.push(patch.responseBody); }
    if (patch.state)                   { sets.push('state = ?');           vals.push(patch.state); }
    if (!sets.length) return;
    vals.push(opId);
    this.db.run(`UPDATE ops SET ${sets.join(', ')} WHERE id = ?`, vals);
  }

  async saveCompensation(c: Omit<Compensation, 'id'>): Promise<Compensation> {
    const id = `comp_${ulid()}`;
    this.db.run(
      `INSERT INTO compensations (id, op_id, step_idx, action, plan, state, attempt)
       VALUES (?,?,?,?,?,?,?)`,
      [id, c.opId, c.stepIdx, c.action, JSON.stringify(c.plan), c.state, c.attempt ?? 0],
    );
    return { ...c, id };
  }

  async listCompensationsByOp(opId: string): Promise<Compensation[]> {
    const rows = this.db.query(`SELECT * FROM compensations WHERE op_id = ? ORDER BY step_idx ASC, attempt DESC`)
                        .all(opId) as any[];
    return rows.map(r => this.rowToComp(r));
  }

  async updateCompensationState(id: string, state: CompState, extra: Partial<Compensation> = {}): Promise<void> {
    const sets: string[] = ['state = ?'];
    const vals: any[] = [state];
    if (extra.attempt != null)    { sets.push('attempt = ?');    vals.push(extra.attempt); }
    if (extra.startedAt != null)  { sets.push('started_at = ?'); vals.push(extra.startedAt); }
    if (extra.endedAt != null)    { sets.push('ended_at = ?');   vals.push(extra.endedAt); }
    if (extra.lastError)          { sets.push('last_error = ?'); vals.push(extra.lastError); }
    vals.push(id);
    this.db.run(`UPDATE compensations SET ${sets.join(', ')} WHERE id = ?`, vals);
  }

  async saveReceipt(r: Receipt): Promise<void> {
    this.db.run(
      `INSERT OR REPLACE INTO receipts (lane_id, exit_code, payload, created_at) VALUES (?,?,?,?)`,
      [r.laneId, r.exitCode, JSON.stringify(r), Date.now()],
    );
  }

  async getReceipt(laneId: LaneId): Promise<Receipt | null> {
    const row = this.db.query(`SELECT payload FROM receipts WHERE lane_id = ?`).get(laneId) as any;
    return row ? JSON.parse(row.payload) : null;
  }

  /**
   * r1: 事务模型选择（详见 §6.6 并发与事务模型约定）。
   *
   * bun:sqlite / better-sqlite3 的 `db.transaction()` **要求 sync 回调**；
   * 传 async 函数会让 transaction 在第一个 await 处就 COMMIT（promise 还是 pending），
   * 从此以后的操作在事务外跑——静默破坏原子性。
   *
   * Option A（Preferred · 默认）：同步事务，回调不可 await 任何 Promise。
   * Cairn 99% 的 tx 都是纯 DB 操作，适合 A。
   */
  withTxSync<T>(fn: (tx: CheckpointSaver) => T): T {
    const run = this.db.transaction(() => fn(this));
    return run();
  }

  /**
   * Option B：需要在事务内部混入异步 I/O 时使用。
   * 用 BEGIN IMMEDIATE 锁 + 应用层 mutex 串行化；谨慎使用（阻塞其他写者）。
   */
  async withTxAsync<T>(fn: (tx: CheckpointSaver) => Promise<T>): Promise<T> {
    await appLevelMutex.acquire();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn(this);
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      appLevelMutex.release();
    }
  }

  /** 向下兼容别名：默认走 sync；若业务代码错误地传 async callback，在 runtime 爆响亮的错误 */
  withTx<T>(fn: (tx: CheckpointSaver) => T): T {
    const result = fn as any;
    if (typeof result === 'function' && result.constructor?.name === 'AsyncFunction') {
      throw new CairnError('ASYNC_IN_SYNC_TX', {
        hint: 'use withTxAsync() — sync transactions cannot await',
      });
    }
    return this.withTxSync(fn);
  }

  // --- row mappers ---
  private rowToLane(r: any): Lane {
    return {
      id: r.id, pipelineId: r.pipeline_id, agentName: r.agent_name,
      state: r.state, frozen: !!r.frozen, attribution: r.attribution, mode: r.mode,
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }
  private rowToOp(r: any): Op {
    // r1: 同时恢复 classifier_result（持久化字段）与 classifierResultCache（runtime 别名），保证旧代码路径不破
    const classifierResult = r.classifier_result_json ? JSON.parse(r.classifier_result_json) : undefined;
    const requestSnapshot  = r.request_snapshot_json  ? JSON.parse(r.request_snapshot_json)  : undefined;
    return {
      id: r.id, laneId: r.lane_id, seq: r.seq, method: r.method, url: r.url,
      urlPath: r.url_path, requestBody: r.request_body, responseStatus: r.response_status,
      responseBody: r.response_body, beforeImage: r.before_image ? JSON.parse(r.before_image) : null,
      classification: r.classification, state: r.state,
      manifestSnapshot: r.manifest_snap ? JSON.parse(r.manifest_snap) : null,
      classifierResult,                           // r1: 持久化字段
      classifierResultCache: classifierResult,    // r1: runtime 别名（向后兼容）
      requestSnapshot,                            // r1: 完整请求快照
      createdAt: r.created_at,
    };
  }
  private rowToComp(r: any): Compensation {
    return {
      id: r.id, opId: r.op_id, stepIdx: r.step_idx, action: r.action,
      plan: JSON.parse(r.plan), state: r.state, attempt: r.attempt,
      lastError: r.last_error, startedAt: r.started_at, endedAt: r.ended_at,
    };
  }
}
```

### 6.4 测试骨架

```ts
// tests/unit/storage/sqlite-saver.test.ts
test('createLane + getLane round-trip', async () => {
  const saver = new SqliteCheckpointSaver(':memory:');
  const lane = await saver.createLane({
    pipelineId: 'p1', agentName: 'a1', state: 'RECORDED',
    frozen: false, attribution: 'high', mode: 'strict',
  });
  const got = await saver.getLane(lane.id);
  expect(got?.pipelineId).toBe('p1');
});

test('appendOp increments seq atomically under concurrent writers', async () => {
  const saver = new SqliteCheckpointSaver(':memory:');
  const lane = await saver.createLane({ pipelineId: 'p1', agentName: 'a', state: 'RECORDED',
                                         frozen: false, attribution: 'high', mode: 'strict' });
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    saver.appendOp(lane.id, {
      method: 'POST', url: '/x', urlPath: '/x', classification: '③', state: 'PASSED',
    } as any)));
  const seqs = results.map(r => r.seq).sort((a, b) => a - b);
  expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
});
```

**已知风险 + 应对**
- **SQLite 单文件在多进程（proxy + CLI revert）下并发写**：WAL + `tryAcquireLaneLock`（r1 原子 CAS）快速失败 + 重试（max 5 次，指数退避 10-200ms）
- **lane timeline 体积增长**：单 lane 100 ops、每 op 请求/响应各 ~10KB → 2MB；Preview 不做冷归档，`cairn lanes --prune` 手动清理
- **`bun:sqlite` Windows native binding 问题**：备胎 `better-sqlite3`，API 相近，换头即可

### 6.5 Restart Durability 契约（r1 新增）

Cairn 守护进程可能被 `kill -9` / OOM kill / OS reboot。`cairn revert --resume <lane>` 要能无信息损失地继续——前提是 **reverter 需要的所有字段都已落 SQLite**。r1 明确以下字段**必须**在 `appendOp()` / compensation plan 入库时持久化；任一缺失都视为 P1 回归：

| 字段 | 表 · 列 | 载体 | 何时写入 |
|---|---|---|---|
| `classifier_result` | `ops.classifier_result_json`（r1 新增） | 完整 `ClassifierResult` JSON（class / reason / entry / approvalRequired / acceptedIrreversible） | Recorder 分类完成、forward 前 |
| `before_image` | `ops.before_image` | `BeforeImage`（body + etag + coverageGaps + fetchedAt） | `captureBeforeImage` 返回后 |
| `compensation_plan` | `compensations.plan` | 每 step 的 `CompensationStepPlan`（url / body / covers / optimistic_lock） | forward 响应完成、初步模板绑定后 |
| `lane_state` / `comp_state` | `lanes.state` / `compensations.state` | 状态机转移 | 每次转移 |
| `request_snapshot` | `ops.request_snapshot_json`（r1 新增） | `RequestSnapshot`（method / url / headers / body / receivedAt / clientConnectionId） | HTTP 请求一进来 |
| `manifest_snap` | `ops.manifest_snap` | 分类时的 manifest entry 原样快照（即使文件后续改了也可复现） | Recorder 分类完成 |

**验证测试**：§12 加一条 "restart-resume" 测试——跑到一半 `kill` daemon、重启 daemon、`cairn revert --resume <lane>`，Receipt 字段与单次跑完的 Receipt 等价（仅 timings 不同）。

### 6.6 并发与事务模型约定（r1 新增）

1. **Preview 默认单 daemon 进程**，多 lane 由 worker pool 串行处理。上层业务几乎不需要 `withTxAsync`——写 SQL 的地方别调用 network I/O。
2. **所有 DB 事务默认 `withTx`（sync）**。如果回调里有 `await`，静态检查器（eslint `no-await-in-tx-callback` 自定义规则）直接报错；runtime 兜底在 `withTx` 里检测 AsyncFunction 抛 `ASYNC_IN_SYNC_TX`。
3. **需要异步 I/O 的极少数场景**（比如 `executeRevert` 本身）**不**在单一 tx 内：每个 DB 步骤各自一个小 tx。跨步骤的原子性由 lane lock + 状态机承担，不靠事务。
4. **Lane lock 是 CAS**：`tryAcquireLaneLock(id, holder, ttl)` 单条 UPDATE 原子获取；过期 TTL（60s）兜底——进程崩溃后 1 分钟内其他进程可抢锁。
5. **v0.3 team 版多进程**：lanes 表 schema 的 `lock_holder` 字符串已预留为 daemon UUID，无需改 schema；需要时只要多个 daemon 共用一个 SQLite 文件（或切 Postgres）即可。

**测试骨架**：

```ts
test('r1: tryAcquireLaneLock is atomic under concurrent callers', async () => {
  const saver = new SqliteCheckpointSaver(':memory:');
  const lane = await saver.createLane({ pipelineId: 'p', agentName: 'a', state: 'RECORDED',
                                         frozen: false, attribution: 'high', mode: 'strict' });
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    saver.tryAcquireLaneLock(lane.id, `holder_${i}`, 30_000)));
  expect(results.filter(Boolean)).toHaveLength(1);   // 恰好一个获得
});

test('r1: withTx refuses async callback', () => {
  const saver = new SqliteCheckpointSaver(':memory:');
  expect(() => saver.withTx(async () => 1 as any)).toThrow(/ASYNC_IN_SYNC_TX/);
});
```

---

## 7. Mode 配置

三种模式对应定位书 §三.3：

| mode | ④ 行为 |
|---|---|
| `strict`（默认） | 阻塞 + approval gate，`cairn approve` 前 proxy 挂起请求 |
| `acceptIrreversible` | 放行 + 自动登记 `accepted-irreversible` + stderr warn |
| `bypass` | 静默放行（仍写 timeline + receipt） |

### 7.1 config.yaml 完整 schema

```yaml
# ~/.cairn/config.yaml
version: 1
mode: strict                    # 全局默认
proxyPort: 7778
daemonSocket: "~/.cairn/daemon.sock"   # POSIX, Windows 用 named pipe
approvalTimeoutSec: 300            # r1: default 5 min, was 600
notify:
  on_approval_pending: "say 'Cairn: approval needed'"  # shell 命令
github:
  apiVersion: "2022-11-28"
  sandboxRepo: "OWNER/cairn-sandbox-preview"   # demo 用
perLane:                        # per-lane 覆盖
  lane_01HX9K8PQRZA:
    mode: bypass
logging:
  level: info                   # debug / info / warn / error
  redact: ["authorization", "x-github-token"]
```

### 7.2 优先级合并

```ts
// src/mode/mode.ts
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import type { ModeConfig, LaneId } from '../types';

const DEFAULT_CONFIG: ModeConfig = {
  mode: 'strict',
  proxyPort: 7778,
  approvalTimeoutSec: 300,           // r1: default 5 min, was 600
  notify: { on_approval_pending: process.platform === 'darwin' ? "say 'Cairn approval needed'"
                                : process.platform === 'linux' ? "notify-send 'Cairn approval needed'"
                                : "powershell -c \"[System.Media.SystemSounds]::Exclamation.Play()\"" },
};

export interface ResolveOpts {
  cliMode?: ModeConfig['mode'];
  laneId?: LaneId;
  home?: string;
}

export function resolveMode(opts: ResolveOpts): ModeConfig {
  // priority: CLI flag > env > perLane > global config > default
  const home = opts.home ?? (process.env.HOME ?? process.env.USERPROFILE!);
  const configPath = join(home, '.cairn', 'config.yaml');
  const fileCfg: Partial<ModeConfig> = existsSync(configPath)
    ? yaml.load(readFileSync(configPath, 'utf8')) as any
    : {};
  let merged: ModeConfig = { ...DEFAULT_CONFIG, ...fileCfg };

  // env
  if (process.env.CAIRN_MODE) merged.mode = process.env.CAIRN_MODE as any;

  // per-lane
  if (opts.laneId && fileCfg.perLane && fileCfg.perLane[opts.laneId]) {
    merged = { ...merged, ...fileCfg.perLane[opts.laneId] };
  }

  // CLI 最高优先级
  if (opts.cliMode) merged.mode = opts.cliMode;

  return merged;
}
```

### 7.3 Strict 模式下 approval gate 连接语义（r1 重写）

r1 对 gate 的**连接生命周期**做完整定义，replace 原第 6 条单行超时描述。关键不变式：**任何 approval 决策都不能让上游以为请求从未发生；任何客户端断连都不能造成决策漏判**。

**默认超时**：`approvalTimeoutSec = 300`（5 min，r1 下调自原 10 min——5 分钟更符合 agent 轮询耐心窗口；用户仍可在 `config.yaml` 覆盖）。

**完整流程**：

1. Classifier 判 ④ → proxy 构造 `RequestSnapshot`（见下）→ 原子 `appendOp` + `ops.state=PENDING_APPROVAL` + `lanes.state=HELD_FOR_HUMAN`
2. proxy 用 `socket.pause()` 挂起**原客户端连接**（TCP 保活，不回响应），同时记录 `clientConnectionId`（应用层 ID，对应内部 Map<id, Socket>）
3. 触发 `notify.on_approval_pending`
4. **三条收敛路径**：

   | 事件 | proxy 行为 | op 最终 state |
   |---|---|---|
   | **Approve** | 若原连接仍活（按 `clientConnectionId` 查 Map）→ 照 `RequestSnapshot` 发上游、把响应流回原 socket；若原连接已断 → 照发上游、响应存 receipt 供 `cairn show` 查询 | `PASSED` |
   | **Deny** | 立刻向原连接写 `499 Client Closed Request`（自定义，借 nginx 语义） + `cairn: denied by user`，然后 close | `BLOCKED` |
   | **Client disconnect 先于 approve** | 从 Map 移除 socket；op 标 `cancelled`；用户之后 approve 时 gate 返回 `{ status: 409, hint: 'client disconnected' }` | `BLOCKED(cancelled)` |
   | **Timeout (300s)** | 向原连接写 `503 Service Unavailable` + `Retry-After: 0`；op 标 `abandoned` | `BLOCKED(timeout)` |

5. **重放安全**：approve 是从 SQLite 的 `request_snapshot_json` 重建请求对象发出，**不是**原始 TCP buffer 转发——即便代理重启也能 resume（前提是 daemon 起来时能重新找到客户端连接；重启后原连接总是死的，走"响应入 receipt"分支）

**RequestSnapshot type**（见附录 A）：

```ts
export interface RequestSnapshot {
  method: string;                       // "POST"
  url: string;                          // 完整绝对 URL（上游）
  headers: Record<string, string>;      // 已剥离 Authorization 的原值（保留 placeholder "<redacted>"）
  body?: unknown;                       // 解析后的 JSON；无法解析时存 raw string
  bodyEncoding?: 'json' | 'raw';
  receivedAt: number;                   // epoch ms
  clientConnectionId: string;           // ulid；对应 proxy 内部 socket Map
}
```

**Schema**：§6.1 `ops` 表新增 `request_snapshot_json TEXT NOT NULL DEFAULT '{}'`；原 `request_body BLOB` 保留过渡（仅存 body bytes）。

**Authorization 处理细节**：snapshot 里 `headers.authorization` **不**存原始 token（避免 SQLite 文件泄露凭据），而是存 lookup 键指向 per-lane 的 OS keychain（macOS Keychain / Linux secret-service / Windows Credential Manager）。发出时再动态回填。Preview 简化：token 经 `process.env.GITHUB_TOKEN` 二次注入，snapshot 里始终只存 `"<redacted>"`。

### 7.4 bypass 模式

④ 操作放行，**但 receipt 依然记录**：
- op `classification=④` + `state=PASSED (bypass)`
- 若该 op 后续被 revert 要求，Reverter 返回 `irreversibleSideEffects[{kind: "bypass-acknowledged"}]`
- **对所有 ③ 部分的 revert 能力不变**——这是 Cairn bypass 与 Claude Code bypass 的本质区别

**已知风险 + 应对**
- **strict 模式下用户离开键盘**：approval 挂起 5 min → 超时返回 503 + Retry-After（r1 语义，见 §7.3）→ agent 可重试或上报给 orchestrator；v0.1 引入 "hold & resume"
- **perLane mode 污染全局**：`cairn lanes` 展示时对 non-default mode 的 lane 有标记，避免用户以为是默认模式
- **长挂起占用 proxy socket**：每 lane 最多 1 条 pending 请求；超出靠 `per-lane backpressure`（返回 429）；单 daemon 全局 pending 上限 64

---

## 8. CLI 契约

所有命令支持 `--json`（机器可读）和默认（human-readable）两种输出。退出码：`0` 成功，`1` 用户错误，`2-5` 映射到 §5 状态机。

### 8.1 命令总览

| 命令 | 入参 | 输出 | 退出码 |
|---|---|---|---|
| `cairn start [--port 7778] [--mode strict]` | 启动 daemon + proxy | `pid`、`socket paths` | 0/1 |
| `cairn stop` | 无 | confirm | 0/1 |
| `cairn status` | 无 | daemon 健康、活跃 lane 数、pending approval 数 | 0/1 |
| `cairn init [--project .]` | 扫描 `.claude/agents/*.md`、写 frontmatter | 改写摘要 | 0/1 |
| `cairn lanes [--pipeline X] [--state reverted]` | 过滤器 | 表格 / JSON array | 0/1 |
| `cairn show <lane-id> [--ops-only]` | 单 lane 详情 | ops 列表 + classification + compensation plan | 0/1 |
| `cairn tail [--lane X]` | 实时 follow | 流式打印 | 0 |
| `cairn revert <lane-id> [--dry-run\|--confirm] [--resume]` | 触发五件套 | 进度 + Receipt | 0/2/3/4/5 |
| `cairn approve <op-id>` | 通过 ④ 拦截 | OK | 0/1 |
| `cairn deny <op-id> [--reason "..."]` | 拒绝 ④ | OK | 0/1 |

### 8.2 顶层 dispatcher

```ts
// src/cli/index.ts
import { Command } from 'commander';
import { cmdStart } from './start';
import { cmdStop } from './stop';
import { cmdStatus } from './status';
import { cmdInit } from './init';
import { cmdLanes } from './lanes';
import { cmdShow } from './show';
import { cmdTail } from './tail';
import { cmdRevert } from './revert';
import { cmdApprove } from './approve';
import { cmdDeny } from './deny';

const program = new Command();
program.name('cairn').version('0.0.1').showHelpAfterError();

program.command('start').option('-p, --port <n>', 'proxy port', '7778')
  .option('-m, --mode <s>', 'strict|acceptIrreversible|bypass')
  .action(async (o) => process.exit(await cmdStart({ port: Number(o.port), mode: o.mode })));

program.command('stop').action(async () => process.exit(await cmdStop()));
program.command('status').option('--json', 'JSON output')
  .action(async (o) => process.exit(await cmdStatus({ json: !!o.json })));

program.command('init').option('--project <p>', 'project root', '.')
  .action(async (o) => process.exit(await cmdInit({ projectRoot: o.project })));

program.command('lanes').option('--pipeline <p>').option('--state <s>').option('--json')
  .action(async (o) => process.exit(await cmdLanes(o)));

program.command('show <laneId>').option('--ops-only').option('--json')
  .action(async (laneId, o) => process.exit(await cmdShow({ laneId, ...o })));

program.command('tail').option('--lane <l>')
  .action(async (o) => process.exit(await cmdTail({ lane: o.lane })));

program.command('revert <laneId>').option('--dry-run').option('--confirm').option('--resume').option('--json')
  .action(async (laneId, o) => process.exit(await cmdRevert({
    lane: laneId, dryRun: !!o.dryRun, confirm: !!o.confirm, resume: !!o.resume, json: !!o.json,
  })));

program.command('approve <opId>').option('--reason <r>')
  .action(async (opId, o) => process.exit(await cmdApprove({ opId, reason: o.reason })));

program.command('deny <opId>').option('--reason <r>')
  .action(async (opId, o) => process.exit(await cmdDeny({ opId, reason: o.reason })));

program.parseAsync(Bun.argv);
```

### 8.3 `cairn start`

```ts
// src/cli/start.ts
import { spawn } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveMode } from '../mode/mode';

export async function cmdStart(args: { port: number; mode?: any }): Promise<number> {
  const home = process.env.HOME ?? process.env.USERPROFILE!;
  const pidFile = join(home, '.cairn', 'daemon.pid');
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8'));
    if (isAlive(pid)) { console.error(`cairn: daemon already running (pid=${pid})`); return 1; }
  }
  const mode = resolveMode({ cliMode: args.mode });
  const child = spawn(process.execPath, [join(import.meta.dir, '../proxy/server.ts')], {
    env: { ...process.env, CAIRN_PORT: String(args.port), CAIRN_MODE: mode.mode },
    detached: true, stdio: ['ignore',
      require('node:fs').openSync(join(home, '.cairn', 'proxy.stdout.log'), 'a'),
      require('node:fs').openSync(join(home, '.cairn', 'proxy.stderr.log'), 'a')],
  });
  child.unref();
  writeFileSync(pidFile, String(child.pid));
  console.log(`cairn started pid=${child.pid} port=${args.port} mode=${mode.mode}`);
  return 0;
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
```

### 8.4 `cairn revert`

```ts
// src/cli/revert.ts
import { SqliteCheckpointSaver } from '../storage/sqlite-saver';
import { CompensatorEngine } from '../reverter/engine';
import { forwardToUpstream } from '../proxy/forwarder';
import type { LaneId } from '../types';

export interface RevertArgs {
  lane: string; dryRun: boolean; confirm: boolean; resume: boolean; json: boolean;
}

export async function cmdRevert(args: RevertArgs): Promise<number> {
  // 1) 互斥校验
  if (args.dryRun && args.confirm) { console.error('--dry-run and --confirm are mutually exclusive'); return 1; }
  const effective = args.dryRun || !args.confirm; // 默认 dry-run

  // 2) 读 lane 是否存在（支持前缀匹配）
  const saver = new SqliteCheckpointSaver(dbPath());
  const lane = await resolveLanePrefix(saver, args.lane);
  if (!lane) { console.error(`lane not found: ${args.lane}`); return 1; }

  // 3) 跑 engine
  const engine = new CompensatorEngine(saver, forwardToUpstream);
  const receipt = await engine.executeRevert(lane.id as LaneId, { dryRun: effective, resume: args.resume });

  // 4) 输出
  if (args.json) {
    console.log(JSON.stringify({ ok: receipt.exitCode === 0, exitCode: receipt.exitCode, receipt }));
  } else {
    printHumanReceipt(receipt, effective);
  }

  // 5) exit code
  return receipt.exitCode;
}

async function resolveLanePrefix(saver: SqliteCheckpointSaver, input: string) {
  if (await saver.getLane(input as any)) return await saver.getLane(input as any);
  const all = await saver.listLanes({});
  const matches = all.filter(l => l.id.startsWith(input));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) return null;
  console.error(`ambiguous lane prefix "${input}", candidates:`);
  for (const m of matches) console.error(`  ${m.id}`);
  return null;
}

function printHumanReceipt(r: any, dry: boolean): void {
  const banner = dry ? '┌─ dry-run · no external calls issued ─┐' : '┌─ revert complete ─┐';
  console.log(banner);
  for (const x of r.reverted) console.log(`  ✓ step ${x.stepIdx} opId=${x.opId}  covers=${x.covers.join(',')}`);
  for (const f of r.failed)   console.log(`  ✗ step ${f.stepIdx} opId=${f.opId}  ${f.code}: ${f.msg}`);
  if (r.irreversibleSideEffects.length) {
    console.log(`  ! irreversible tail:`);
    for (const i of r.irreversibleSideEffects) console.log(`      - ${i.kind} (detectable=${i.detectable})`);
  }
  console.log(`  exit ${r.exitCode}  wall ${r.timings.wallMs}ms`);
}
```

### 8.5 `cairn approve` / `cairn deny`（r1 连接语义落地）

与 §7.3 完整对齐：approve 时 daemon 侧需要先检查客户端连接是否仍活，走不同分支；deny 时立刻结束原连接。

```ts
// src/cli/approve.ts
import { openDaemonSocket, sendDaemonCmd } from './daemon-client';

export async function cmdApprove(args: { opId: string; reason?: string }): Promise<number> {
  try {
    const sock = await openDaemonSocket();
    const resp = await sendDaemonCmd(sock, { type: 'approve', opId: args.opId, reason: args.reason });
    if (resp.ok) {
      // r1: daemon 反回三种 ok 细分
      if (resp.clientAlive) {
        console.log(`approved ${args.opId} — response streamed to agent`);
      } else if (resp.clientDisconnected) {
        console.log(`approved ${args.opId} — agent disconnected; response stored in receipt. `
                    + `use 'cairn show ${args.opId}' to inspect.`);
      } else if (resp.alreadyResolved) {
        console.log(`approved ${args.opId} — already ${resp.previousState} (idempotent)`);
      }
      return 0;
    }
    console.error(`cairn: ${resp.error}`);
    return 1;
  } catch (e: any) {
    console.error(`cairn: daemon not running; run 'cairn start'`);
    return 1;
  }
}
```

```ts
// src/cli/deny.ts
export async function cmdDeny(args: { opId: string; reason?: string }): Promise<number> {
  const sock = await openDaemonSocket();
  const resp = await sendDaemonCmd(sock, { type: 'deny', opId: args.opId, reason: args.reason });
  if (!resp.ok) { console.error(`cairn: ${resp.error}`); return 1; }
  // r1: daemon 已经向原客户端连接写 499 Client Closed Request 并 close
  console.log(`denied ${args.opId}${args.reason ? ` (${args.reason})` : ''} — client connection closed with 499`);
  return 0;
}
```

**Daemon 侧伪码**（`src/proxy/approval-queue.ts`）：

```ts
async function handleApprove(opId: string): Promise<ApproveResp> {
  const op = await saver.getOp(opId);
  if (!op || op.state !== 'PENDING_APPROVAL') {
    return { ok: true, alreadyResolved: true, previousState: op?.state };
  }
  const snapshot = op.requestSnapshot!;                    // r1: 从 SQLite 重建
  const sock = pendingSockets.get(snapshot.clientConnectionId); // Map<id, Socket>
  const resolver = new TemplateResolver({ path: {}, request: snapshot.body as any });
  const upstreamResp = await forwardToUpstream({ ...snapshot, headers: withAuth(snapshot.headers) });
  await saver.updateOp(opId, { state: 'PASSED', responseStatus: upstreamResp.status,
                                responseBody: upstreamResp.body });
  if (sock && !sock.destroyed) {
    writeHttpResponseTo(sock, upstreamResp); sock.end();
    return { ok: true, clientAlive: true };
  } else {
    return { ok: true, clientDisconnected: true };
  }
}

async function handleDeny(opId: string, reason?: string): Promise<DenyResp> {
  const op = await saver.getOp(opId);
  if (!op) return { ok: false, error: 'NOT_FOUND' };
  const sock = pendingSockets.get(op.requestSnapshot!.clientConnectionId);
  if (sock && !sock.destroyed) {
    sock.write(`HTTP/1.1 499 Client Closed Request\r\nContent-Type: text/plain\r\n\r\n` +
               `cairn: denied by user${reason ? ' (' + reason + ')' : ''}\n`);
    sock.end();
  }
  await saver.updateOp(opId, { state: 'BLOCKED' });
  return { ok: true };
}

// 定时扫描 pending 超时
setInterval(async () => {
  const stale = await saver.findPendingApprovalsOlderThan(config.approvalTimeoutSec * 1000);
  for (const op of stale) {
    const sock = pendingSockets.get(op.requestSnapshot!.clientConnectionId);
    if (sock && !sock.destroyed) {
      sock.write(`HTTP/1.1 503 Service Unavailable\r\nRetry-After: 0\r\n\r\n` +
                 `cairn: approval timeout after ${config.approvalTimeoutSec}s\n`);
      sock.end();
    }
    await saver.updateOp(op.id, { state: 'BLOCKED' });
  }
}, 10_000);
```

### 8.6 `cairn lanes`

```ts
// src/cli/lanes.ts
export async function cmdLanes(args: { pipeline?: string; state?: string; json?: boolean }): Promise<number> {
  const saver = new SqliteCheckpointSaver(dbPath());
  const lanes = await saver.listLanes({
    pipelineId: args.pipeline,
    state: args.state as any,
  });
  if (args.json) { console.log(JSON.stringify(lanes)); return 0; }
  // Table
  console.log('LANE                          AGENT          STATE           MODE         FROZEN');
  for (const l of lanes) {
    console.log(`${l.id.padEnd(30)}${l.agentName.padEnd(15)}${l.state.padEnd(16)}${l.mode.padEnd(13)}${l.frozen ? 'YES' : '-'}`);
  }
  return 0;
}
```

### 8.7 `cairn show`

```ts
// src/cli/show.ts
export async function cmdShow(args: { laneId: string; opsOnly?: boolean; json?: boolean }): Promise<number> {
  const saver = new SqliteCheckpointSaver(dbPath());
  const lane = await saver.getLane(args.laneId as any);
  if (!lane) { console.error(`lane not found`); return 1; }
  const ops = await saver.getOpsByLane(lane.id as any);
  const payload: any = { lane, ops };
  if (!args.opsOnly) {
    payload.compensations = {};
    for (const op of ops) payload.compensations[op.id] = await saver.listCompensationsByOp(op.id);
    payload.receipt = await saver.getReceipt(lane.id as any);
  }
  if (args.json) { console.log(JSON.stringify(payload, null, 2)); return 0; }
  printLaneHuman(payload);
  return 0;
}
```

### 8.8 `cairn tail`

```ts
// src/cli/tail.ts
import { connectDaemonEvents } from './daemon-client';

export async function cmdTail(args: { lane?: string }): Promise<number> {
  const stream = await connectDaemonEvents(args.lane);
  for await (const ev of stream) {
    const ts = new Date(ev.ts).toISOString();
    console.log(`[${ts}] ${ev.type} lane=${ev.laneId} op=${ev.opId ?? '-'} ${ev.msg ?? ''}`);
  }
  return 0;
}
```

### 8.9 `cairn status` / `cairn stop`

```ts
// src/cli/status.ts
export async function cmdStatus(args: { json?: boolean }): Promise<number> {
  const pid = readPid();
  if (!pid) { args.json ? console.log('{"running":false}') : console.log('cairn: not running'); return 1; }
  const saver = new SqliteCheckpointSaver(dbPath());
  const lanes = await saver.listLanes({});
  const pendingApproval = lanes.filter(l => l.state === 'HELD_FOR_HUMAN').length;
  const payload = { running: true, pid, port: 7778, lanes: lanes.length, pendingApproval };
  args.json ? console.log(JSON.stringify(payload)) : console.log(`cairn running pid=${pid} lanes=${lanes.length} pending=${pendingApproval}`);
  return 0;
}

// src/cli/stop.ts
export async function cmdStop(): Promise<number> {
  const pid = readPid();
  if (!pid) { console.error('cairn: not running'); return 1; }
  try { process.kill(pid, 'SIGTERM'); removePidFile(); console.log('cairn stopped'); return 0; }
  catch { console.error('cairn: failed to stop'); return 1; }
}
```

### 8.10 JSON 输出契约

```json
// cairn revert --json 成功
{"ok":true,"exitCode":0,"receipt":{...}}
// 失败
{"ok":false,"exitCode":2,"receipt":{...},"error":{"code":"PARTIAL_UNDO","msg":"..."}}
```

**`--dry-run` 行为**：跑完整 invariant check + optimistic lock 预检查（HEAD/GET 请求），**不发任何 mutating 请求**，输出完整 plan。Dry-run 失败 → 建议用户 `cairn revert --confirm` 前先修 conflict。

**已知风险 + 应对**
- **CLI 在 daemon 没启动时被调用**：`cairn: daemon not running; run 'cairn start'`，退出码 1
- **lane-id 前缀匹配**：`cairn show lane_01HX9` 匹配唯一前缀即可，多匹配则列出候选
- **Windows 下 SIGTERM 无效**：用 `process.kill(pid, 'SIGINT')` 或调 `taskkill /F /PID ...`

---

## 9. MCP 工具契约

**Preview 不暴露 MCP 工具**（只跑 HTTP proxy）。但为了让 v0.1 不重写，此处冻结 6 个工具的 schema。Preview 的 `receipt` / `op` JSON 格式与此处一致。

### 9.1 工具列表 + 契约

| 工具 | input | output | 幂等性 |
|---|---|---|---|
| `cairn.list_lanes` | `{pipelineId?, state?}` | `{lanes: Lane[]}` | ✓ |
| `cairn.show_lane` | `{laneId}` | `{lane, ops, compensations}` | ✓ |
| `cairn.classify_preview` | `{method, url, body?}` | `{class, entry?, reason}` | ✓（无副作用） |
| `cairn.revert_lane` | `{laneId, dryRun, idempotencyKey}` | `{receipt, exitCode}` | 通过 idempotencyKey 去重 |
| `cairn.approve_op` | `{opId, reason?}` | `{ok: true}` | ✓（重复 approve 返回同结果） |
| `cairn.deny_op` | `{opId, reason}` | `{ok: true}` | ✓ |

### 9.2 Zod schemas + MCP handler 代码

```ts
// src/mcp/schemas.ts  (v0.1 启用，Preview 冻结保持 wire compatibility)
import { z } from 'zod';

export const LaneIdSchema = z.string().regex(/^lane_[0-9A-Z]{26}$/);
export const OpIdSchema = z.string().regex(/^op_[0-9A-Z]{26}$/);

export const ListLanesInput = z.object({
  pipelineId: z.string().optional(),
  state: z.enum(['RECORDED','REVERTING','REVERTED','PARTIAL_REVERT','HELD_FOR_HUMAN','FAILED_RETRYABLE']).optional(),
});

export const ShowLaneInput = z.object({ laneId: LaneIdSchema });

export const ClassifyPreviewInput = z.object({
  method: z.string(),
  url: z.string().url(),
  body: z.record(z.unknown()).optional(),
});

export const RevertLaneInput = z.object({
  laneId: LaneIdSchema,
  dryRun: z.boolean().default(true),
  idempotencyKey: z.string().min(8).max(64),
});

export const ApproveDenyInput = z.object({
  opId: OpIdSchema,
  reason: z.string().optional(),
});
```

```ts
// src/mcp/server.ts (v0.1 MCP server entry; Preview 里同样代码编译，但 daemon 不挂这个端口)
import { Server } from '@modelcontextprotocol/sdk/server';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio';
import { ListLanesInput, ShowLaneInput, ClassifyPreviewInput, RevertLaneInput, ApproveDenyInput } from './schemas';

export function createMcpServer(deps: { saver: CheckpointSaver; classifier: Classifier; engine: CompensatorEngine }) {
  const server = new Server({ name: 'cairn', version: '0.0.1' }, { capabilities: { tools: {} } });

  server.registerTool('cairn.list_lanes', { inputSchema: ListLanesInput }, async (input) => {
    const lanes = await deps.saver.listLanes(input);
    return { lanes };
  });

  server.registerTool('cairn.show_lane', { inputSchema: ShowLaneInput }, async ({ laneId }) => {
    const lane = await deps.saver.getLane(laneId as any);
    if (!lane) throw new CairnError('NOT_FOUND', { laneId });
    const ops = await deps.saver.getOpsByLane(laneId as any);
    const comps: Record<string, any[]> = {};
    for (const o of ops) comps[o.id] = await deps.saver.listCompensationsByOp(o.id);
    return { lane, ops, compensations: comps };
  });

  server.registerTool('cairn.classify_preview', { inputSchema: ClassifyPreviewInput }, async (input) => {
    return deps.classifier.classify({
      method: input.method, urlPath: new URL(input.url).pathname, headers: {}, body: input.body,
    } as any);
  });

  server.registerTool('cairn.revert_lane', { inputSchema: RevertLaneInput }, async (input) => {
    // Idempotency guard
    const cached = await deps.saver.getReceipt(input.laneId as any);
    if (cached && cached.idempotencyKey === input.idempotencyKey) return { receipt: cached, exitCode: cached.exitCode };
    const receipt = await deps.engine.executeRevert(input.laneId as any, { dryRun: input.dryRun });
    (receipt as any).idempotencyKey = input.idempotencyKey;
    await deps.saver.saveReceipt(receipt);
    return { receipt, exitCode: receipt.exitCode };
  });

  server.registerTool('cairn.approve_op', { inputSchema: ApproveDenyInput }, async ({ opId, reason }) => {
    await approvalQueue.approve(opId, reason);
    return { ok: true };
  });

  server.registerTool('cairn.deny_op', { inputSchema: ApproveDenyInput.extend({ reason: z.string() }) }, async ({ opId, reason }) => {
    await approvalQueue.deny(opId, reason);
    return { ok: true };
  });

  return server;
}
```

### 9.3 错误码（统一 `CairnError.code`）

```
NOT_IN_MANIFEST          分类未命中
INCOMPLETE_BEFORE_IMAGE  invariant check 失败
CONFLICT                 optimistic lock 失败
BEFORE_IMAGE_TIMEOUT     前像抓取超时
BEFORE_IMAGE_UNAVAILABLE 上游 4xx/5xx
LANE_FROZEN              partial-revert 后禁止新 op
LANE_BUSY                lane 已有其他 revert 持锁
APPROVAL_DENIED
APPROVAL_TIMEOUT
DAEMON_NOT_RUNNING
INVALID_SUBAGENT
NOT_FOUND
```

**已知风险 + 应对**
- **revert 非幂等**：调用方必须带 `idempotencyKey`；Reverter 内部用 `(lane_id + 'revert' + key)` 去重，重复 call 返回同一 receipt
- **MCP schema v0.0.1 冻结后改动**：任何不兼容变更推迟到 v0.2，v0.1 保持向后兼容

---

## 10. GitHub Adapter Manifest

`manifests/github.yaml`——Preview 唯一 adapter，涵盖定位书 §十里的 8 个端点。完整内容见附录 B。

### 10.1 加载器 + validation

```ts
// src/classifier/manifest-loader.ts
import yaml from 'js-yaml';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

// r1: optimistic_lock 由单一 { type, value } 扩展为 union，支持 etag / version-check / field-match 三型
const OptLockEtagSchema = z.object({
  type: z.literal('etag'),
  value: z.string(),          // ${before_image.etag} 或固定字符串
});
const OptLockVersionSchema = z.object({
  type: z.literal('version-check'),
  field: z.string(),          // 比如 "updated_at"
  expected: z.string(),       // ${before_image.updated_at}
});
const OptLockFieldMatchSchema = z.object({
  type: z.literal('field-match'),
  probe_url: z.string(),      // "GET /repos/.../labels"
  compare_strategy: z.enum(['must_contain','must_not_contain','exact_match']),
  compare_value: z.string(),  // 经 TemplateResolver 解析
});
const OptLockSchema = z.discriminatedUnion('type', [
  OptLockEtagSchema, OptLockVersionSchema, OptLockFieldMatchSchema,
]);

const StepPlanSchema = z.object({
  action: z.string(),
  method: z.string().optional(),
  url: z.string().optional(),
  body: z.record(z.unknown()).optional(),
  covers: z.array(z.string()).default([]),
  best_effort: z.boolean().default(false),
  optimistic_lock: OptLockSchema.optional(),
});

const EntrySchema = z.object({
  method: z.string(),
  path: z.string(),
  class: z.enum(['①','②','③','④']),
  class_reason: z.string(),
  before_image: z.object({
    capture_via: z.string().nullable().optional(),
    extra_latency_budget_ms: z.number().default(500),
    coverage_gaps: z.array(z.object({ field: z.string(), reason: z.string().optional() })).default([]),
  }).default({ capture_via: null, extra_latency_budget_ms: 500, coverage_gaps: [] }),
  undo_strategy: z.object({
    tier: z.enum(['L0-pure','L1-bounded','L2-cross-system','L3-irreversible-tail']),
    compensator_chain: z.array(StepPlanSchema).default([]),
    unreversible_tail: z.array(z.object({ kind: z.string(), detectable: z.boolean(), via: z.string().optional() })).default([]),
  }),
  requires_approval_when: z.array(z.object({ always: z.boolean().optional(), expr: z.string().optional() })).default([]),
});

const ManifestSchema = z.object({
  adapter: z.string(),
  api_version: z.string().optional(),
  base_url: z.string(),
  preview_only: z.boolean().default(false),
  entries: z.array(EntrySchema),
});

export function loadGithubManifest(path: string) {
  const raw = readFileSync(path, 'utf8');
  const parsed = yaml.load(raw);
  const result = ManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`manifest validation failed:\n${JSON.stringify(result.error.flatten(), null, 2)}`);
  }
  return result.data;
}
```

### 10.2 ④ 拦截的两个端点（关键摘要）

**端点 7：merge PR**——真实世界影响最大，必须 approval。

```yaml
- method: PUT
  path: /repos/{owner}/{repo}/pulls/{number}/merge
  class: "④"
  class_reason: "merge triggers CI / deploy webhooks / protected branch history"
  requires_approval_when:
    - always: true
  undo_strategy:
    tier: L3-irreversible-tail
    compensator_chain: []
    unreversible_tail:
      - { kind: "ci-run",        detectable: true,  via: "GET /repos/${path.owner}/${path.repo}/actions/runs?head_sha=${response.sha}" }
      - { kind: "webhook-delivery", detectable: true, via: "GET /repos/${path.owner}/${path.repo}/hooks" }
      - { kind: "downstream-deploy", detectable: false }
```

**端点 8：delete branch**——硬删 ref，数据层不可逆。

```yaml
- method: DELETE
  path: /repos/{owner}/{repo}/git/refs/heads/{branch}
  class: "④"
  requires_approval_when: [{ always: true }]
  undo_strategy:
    tier: L3-irreversible-tail
    compensator_chain:
      - action: "github:create-ref"
        method: POST
        url: "/repos/${path.owner}/${path.repo}/git/refs"
        body: { ref: "refs/heads/${path.branch}", sha: "${before_image.object.sha}" }
        covers: ["ref", "object.sha"]
        best_effort: true
    unreversible_tail:
      - { kind: "PR-base-orphan",        detectable: true  }
      - { kind: "protected-branch-rules", detectable: false }
```

### 10.3 Optimistic lock `field-match` 完整体（r1 新增）

Labels / tags / collaborators 这类资源 GitHub 不返回 ETag，无法用 `If-Match`。r1 给出**不依赖 ETag 的 field-match 协议**：发 compensator 前先 GET 当前集合、按 `compare_strategy` 判断，失败即 `CONFLICT`。

Manifest 示例：对应附录 B.1 "#6 加 label"

```yaml
optimistic_lock:
  type: "field-match"
  probe_url: "GET /repos/${path.owner}/${path.repo}/issues/${path.issue_number}/labels"
  compare_strategy: "must_contain"   # 确认 label 仍存在才撤
  compare_value: "${request.labels.0}"
```

三种 `compare_strategy`：

| strategy | 语义 | 典型场景 |
|---|---|---|
| `must_contain` | probe 响应是 array，`compare_value` 必须出现在里面 | 撤 "加 label"——label 仍在才需要撤 |
| `must_not_contain` | probe 响应是 array，`compare_value` 必须**不**出现 | 撤 "删 label"——label 已经没了才需要加回 |
| `exact_match` | probe 响应标量值 / 对象 `===` `compare_value` | 版本号字段精确对齐 |

Compensator engine 执行：见 §5.3 `executeFieldMatch` 与 `verifyOptLockResponse` r1 实现。

**已知风险 + 应对**
- **GitHub API 版本漂移**：manifest 头部冻结 `github_api_version: "2022-11-28"`，启动时检查实际 header 不一致则警告
- **sandbox 权限不足**：`cairn init` 跑一次 `GET /user` 预检，要求 fine-grained + Issues / Contents / Pull requests = write
- **manifest 里 url template 写错**：schema validation 打早，启动就 exit 1
- **field-match probe 本身被并发修改**：probe → compensator 之间存在极短 TOCTOU 窗口，Preview 接受（窗口 < 50ms，且 compensator 失败会 `CONFLICT`+abort，不会静默覆盖）

### 10.4 Mock GitHub Server 实现（Preview demo 默认轨）

§2.3 承诺的 "mock 轨" 具体落在 `demo/gh-mock-server.ts`，为 Preview 的 8 端点提供**本地 HTTP-only 对等实现**，让 demo / fault tests / CI 不依赖真 GitHub。

**设计原则**：
- 状态完全驻内存（`Map<string, unknown>`），每次 server boot 清空——demo 可重复跑
- 响应的 HTTP status / header / body shape 与真 GitHub API 对齐（参考 `api.github.com` 2022-11-28 版的 fixture）
- 支持模拟错误：query string `?__force_status=500` 强制返回错误，用于 fault injection
- 监听 `127.0.0.1:3000`（避免 bind 公网）

**Bun 实现骨架**

```ts
// demo/gh-mock-server.ts
import { ulid } from 'ulid';

interface State {
  refs: Map<string, { sha: string }>;                  // key: "owner/repo/branch"
  prs: Map<string, { number: number; state: string; title: string; body: string; head: string; base: string; merged: boolean; etag: string }>;
  issues: Map<string, { number: number; state: string; title: string; body: string; labels: string[] }>;
  comments: Map<string, { id: number; body: string; issue_number: number }>;
  counter: { pr: number; issue: number; comment: number };
}

const state: State = {
  refs: new Map(), prs: new Map(), issues: new Map(), comments: new Map(),
  counter: { pr: 0, issue: 0, comment: 0 },
};

function key(o: string, r: string, extra?: string | number) {
  return `${o}/${r}${extra != null ? '/' + extra : ''}`;
}

function forcedStatus(url: URL): number | null {
  const v = url.searchParams.get('__force_status');
  return v ? Number(v) : null;
}

export function startMockGithub(port = 3000) {
  return Bun.serve({
    port,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const forced = forcedStatus(url);
      if (forced && forced >= 400) return new Response(`{"message":"forced ${forced}"}`, { status: forced });

      const body = (req.method === 'GET' || req.method === 'DELETE') ? null : await req.json().catch(() => ({}));
      const p = url.pathname;

      // Route 1: POST /repos/{o}/{r}/git/refs   —— 创建 branch
      const m1 = p.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/refs$/);
      if (m1 && req.method === 'POST') {
        const [, o, r] = m1;
        const refShort = String((body as any).ref).replace(/^refs\/heads\//, '');
        state.refs.set(key(o, r, refShort), { sha: (body as any).sha });
        return Response.json({ ref: (body as any).ref, object: { sha: (body as any).sha } }, { status: 201 });
      }

      // Route 2: DELETE /repos/{o}/{r}/git/refs/heads/{branch}
      const m2 = p.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/refs\/heads\/(.+)$/);
      if (m2 && req.method === 'DELETE') {
        const [, o, r, branch] = m2;
        state.refs.delete(key(o, r, branch));
        return new Response(null, { status: 204 });
      }
      if (m2 && req.method === 'GET') {
        const [, o, r, branch] = m2;
        const ref = state.refs.get(key(o, r, branch));
        if (!ref) return Response.json({ message: 'Not Found' }, { status: 404 });
        return Response.json({ ref: `refs/heads/${branch}`, object: { sha: ref.sha } });
      }

      // Route 3: POST /repos/{o}/{r}/pulls  —— 创建 PR
      const m3 = p.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls$/);
      if (m3 && req.method === 'POST') {
        const [, o, r] = m3;
        const n = ++state.counter.pr;
        state.prs.set(key(o, r, n), {
          number: n, state: 'open',
          title: (body as any).title ?? '', body: (body as any).body ?? '',
          head: (body as any).head, base: (body as any).base, merged: false,
          etag: `W/"${ulid()}"`,
        });
        return Response.json({ number: n, state: 'open', title: (body as any).title, head: { ref: (body as any).head } }, { status: 201 });
      }

      // Route 4: PATCH/GET /repos/{o}/{r}/pulls/{n}
      const m4 = p.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/);
      if (m4) {
        const [, o, r, ns] = m4; const n = Number(ns);
        const pr = state.prs.get(key(o, r, n));
        if (!pr) return Response.json({ message: 'Not Found' }, { status: 404 });
        if (req.method === 'GET') {
          return Response.json(pr, { headers: { etag: pr.etag } });
        }
        if (req.method === 'PATCH') {
          const ifMatch = req.headers.get('if-match');
          if (ifMatch && ifMatch !== pr.etag) return new Response(null, { status: 412 });
          Object.assign(pr, body ?? {});
          pr.etag = `W/"${ulid()}"`;
          return Response.json(pr, { headers: { etag: pr.etag } });
        }
      }

      // Route 5: PUT /repos/{o}/{r}/pulls/{n}/merge
      const m5 = p.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge$/);
      if (m5 && req.method === 'PUT') {
        const [, o, r, ns] = m5;
        const pr = state.prs.get(key(o, r, Number(ns)));
        if (!pr) return Response.json({ message: 'Not Found' }, { status: 404 });
        pr.merged = true; pr.state = 'closed';
        return Response.json({ sha: `merge_${ulid()}`, merged: true });
      }

      // Route 6: POST /repos/{o}/{r}/issues
      const m6 = p.match(/^\/repos\/([^/]+)\/([^/]+)\/issues$/);
      if (m6 && req.method === 'POST') {
        const [, o, r] = m6;
        const n = ++state.counter.issue;
        state.issues.set(key(o, r, n), { number: n, state: 'open',
          title: (body as any).title ?? '', body: (body as any).body ?? '', labels: [] });
        return Response.json({ number: n, state: 'open' }, { status: 201 });
      }

      // Route 7: POST /repos/{o}/{r}/issues/{n}/comments
      const m7 = p.match(/^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/);
      if (m7 && req.method === 'POST') {
        const [, o, r, ns] = m7;
        const id = ++state.counter.comment;
        state.comments.set(String(id), { id, body: (body as any).body ?? '', issue_number: Number(ns) });
        return Response.json({ id, body: (body as any).body }, { status: 201 });
      }
      const m7d = p.match(/^\/repos\/([^/]+)\/([^/]+)\/issues\/comments\/(\d+)$/);
      if (m7d && req.method === 'DELETE') {
        state.comments.delete(m7d[3]);
        return new Response(null, { status: 204 });
      }

      // Route 8: POST / DELETE / GET /repos/{o}/{r}/issues/{n}/labels
      const m8 = p.match(/^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/labels$/);
      if (m8) {
        const [, o, r, ns] = m8;
        const iss = state.issues.get(key(o, r, Number(ns)));
        if (!iss) return Response.json({ message: 'Not Found' }, { status: 404 });
        if (req.method === 'GET')  return Response.json(iss.labels.map(name => ({ name })));
        if (req.method === 'POST') {
          const add = ((body as any).labels ?? []) as string[];
          iss.labels = [...new Set([...iss.labels, ...add])];
          return Response.json(iss.labels.map(name => ({ name })), { status: 200 });
        }
      }
      const m8d = p.match(/^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/labels\/(.+)$/);
      if (m8d && req.method === 'DELETE') {
        const [, o, r, ns, name] = m8d;
        const iss = state.issues.get(key(o, r, Number(ns)));
        if (!iss) return new Response(null, { status: 404 });
        iss.labels = iss.labels.filter(l => l !== decodeURIComponent(name));
        return new Response(null, { status: 204 });
      }

      return Response.json({ message: 'Not Found' }, { status: 404 });
    },
  });
}

if (import.meta.main) startMockGithub(Number(process.env.MOCK_PORT ?? 3000));
```

**CLI 集成**：`bun demo/run-demo.sh` 先 `bun demo/gh-mock-server.ts &`、再 `cairn start --upstream-base=http://127.0.0.1:3000 --mode strict`。`--upstream-base` 是 Preview r1 新增的 proxy flag，覆盖 manifest 里的 `base_url` 指向 mock。

**与 fault tests 的对齐**：§5.9 里的三个 fault test 直接 import `startMockGithub` 作为 helper，不再依赖外部 fixtures。

---

## 11. 3 周工程计划（Day 级）

所有 deliverable 必须有 **ship evidence**（commit / test 绿 / 可跑命令），risk 列当天最可能 block 的点。

### Day 0（周日半天）：Setup

- Bun 安装、GitHub sandbox repo 开（名 `cairn-sandbox-preview`）、fine-grained token 配
- `cairn/` 仓库 init、package.json、tsconfig.json、eslint、bun test hello
- **具体文件**：`package.json` / `tsconfig.json` / `.eslintrc.json` / `tests/unit/hello.test.ts`
- **Deliverable**：`bun test` 跑通 `sum(1,2) === 3`；`~/.cairn/` 目录自动创建
- **Evidence**：commit `chore: bootstrap`
- **Risk**：Bun 在 Windows 下 sqlite native binding——确认 `bun:sqlite` 可用，不行立刻切 `better-sqlite3`

### Week 1：proxy + SQLite + CLI + manifest loader

| Day | 目标 | 具体模块 | Ship evidence | Risk |
|---|---|---|---|---|
| **1** | HTTP forward proxy 骨架 | `src/proxy/server.ts`, `src/proxy/forwarder.ts` | `bun run src/proxy/server.ts` 起在 7778；curl 经 proxy 打到 `api.github.com/user` 成功；日志打印原始请求 + `remoteAddress:remotePort` | CONNECT tunnel for HTTPS |
| **2** | SQLite schema + `SqliteCheckpointSaver` | `src/storage/schema.sql`, `src/storage/saver.ts`, `src/storage/sqlite-saver.ts` | `bun test tests/unit/storage/` 绿，≥ 12 测试用例 | 并发写 WAL 冲突 |
| **3** | Lane attribution L1 + L3 | `src/attribution/resolver.ts`, `inline-mcp.ts`, `pid-lookup.ts`, `src/cli/init.ts` | `cairn init` 改写 fixture frontmatter；Layer 3 netstat 命中；POC 复现 6/6 | Windows netstat 格式 |
| **4** | Manifest loader + Classifier L0 | `src/classifier/classify.ts`, `manifest.ts`, `path-match.ts`, `manifests/github.yaml` | 8 端点每个一条 unit test 对齐预期 class + classReason | URL template 精度 |
| **5** | CLI start/stop/status/lanes/show/tail/init | `src/cli/*.ts`, `src/cli/daemon-client.ts` | 手工跑 10 个命令；JSON 输出符合契约 | 跨平台 daemon |

### Week 2：compensator engine 五件套 + fault injection suite

| Day | 目标 | 具体模块 | Ship evidence | Risk |
|---|---|---|---|---|
| **1** | Before-image + invariant check | `src/reverter/before-image.ts`, `invariant.ts` | Unit test `INCOMPLETE_BEFORE_IMAGE` 抛出；mock GET 超时 → `BEFORE_IMAGE_TIMEOUT` | 超时处理 |
| **2** | Optimistic lock + idempotency | `src/reverter/optlock.ts`, `idempotency.ts` | 单测：412 → CONFLICT；重放同 key 返回同 receipt | GitHub ETag 语义 |
| **3** | 两级状态机 | `src/reverter/state-machine.ts` | 转移表穷举单测：每个状态 × 每个 event 都有期望值 | Resume 逻辑 |
| **4** | Receipt 全字段 + CLI show 格式化 | `src/reverter/receipt.ts`, `src/cli/show.ts` | E2E: revert 一条 lane 打印 receipt JSON；`reverted[]` + `irreversibleSideEffects[]` 不重叠 | JSON schema 锁死 |
| **5** | **3 个 fault injection 场景进 CI** | `tests/fault/F-invariant.test.ts`, `F-optlock.test.ts`, `F-midstep.test.ts` + `tests/helpers/*` | `bun test tests/fault/` 3 绿，重跑 3 次不 flaky | Fault test flakiness |

**Fault 场景复刻**：
- F-invariant ← `D:\lll\cairn\cairn-poc\compensator\FAULT_INJECTION\f1a-github-before-image-missing-labels.js`
- F-optlock ← `f1c-sql-concurrent-write.js`（改写为 GitHub `If-Match` 场景）
- F-midstep ← `f2a-jira-bulk-revert-step-fail.js`（改写为 GitHub 多 step）

### Week 3：Mock demo + screencast +（stretch）HTTPS MITM

| Day | 目标 | 具体模块 | Ship evidence | Risk |
|---|---|---|---|---|
| **1-2** | **Mock GitHub server + demo 集成**（r1 主轨） | `demo/gh-mock-server.ts`, `demo/run-demo.sh`, `src/proxy/server.ts --upstream-base` | `bun demo/run-demo.sh` 端到端跑通 8 端点、Receipt 非空、零外网依赖；fault tests 全部改走 mock | mock 与真 GH 行为偏差 |
| **3** | `cairn approve/deny` + strict mode gate | `src/proxy/approval-queue.ts`, `src/cli/approve.ts`, `deny.ts` | `cairn start --mode strict`：merge PR 挂起；另一终端 approve；断连 / 超时两条语义都被验证（§7.3） | 挂起请求超时 UX |
| **4** | Screencast 脚本 + 录制 + README + install.sh + LICENSE | `demo/screencast-script.md`, 根目录文件 | 5min 视频 `demo/screencast.mp4`；`curl install.sh \| sh` 干净 VM 跑通 | 演员卡壳 / Bun 跨平台安装 |
| **4-5 (stretch)** | **HTTPS MITM opt-in 轨**（§13.4） | `src/proxy/mitm/ca-gen.ts`, `src/proxy/mitm/cert-signer.ts`, `cairn init --with-mitm`, `cairn start --mitm` | macOS + Linux keychain 接受 CA；真连 `api.github.com` 走 MITM 抓明文 | Windows cert store 自动化，Node undici 单独配置 |
| **5** | HN / X 发布 + GitHub Actions CI | `.github/workflows/ci.yml` | CI 绿 + 前 3 条非作者 issue | HN 沉没 |

**硬成功判据**（三选一即可 ship）：
- GitHub 100 star / 视频 1k view / 3 个非作者 issue

**总体已知风险 + 应对**
- **screencast 录了没热度**：demo 本身可独立挂 HN / X / r/ClaudeAI，每平台不同措辞
- **Bun 生态在 Windows 下不稳**：备胎是 Node 22 + `better-sqlite3`，Week 1 Day 5 预留切换窗口
- **fault test 对 GitHub sandbox 的依赖**：fault test 用本地 mock server，不连真 GitHub，保证 CI 稳定

---

## 12. 测试策略

### 12.1 Unit test 覆盖率目标

行覆盖 ≥ 75%，分支覆盖 ≥ 65%；核心模块（classifier / reverter / saver）**强制 ≥ 90%**：

```
src/classifier/classify.ts           → ≥ 95%
src/reverter/engine.ts               → ≥ 95%
src/reverter/invariant.ts            → 100%
src/storage/sqlite-saver.ts          → ≥ 90%
src/cli/*.ts                          → ≥ 60%
```

### 12.2 Classifier 完整单测示例

```ts
// tests/unit/classifier/classify.test.ts
import { test, expect, beforeEach } from 'bun:test';
import { Classifier } from '../../../src/classifier/classify';
import { ManifestRegistry } from '../../../src/classifier/manifest';

let registry: ManifestRegistry;
let classifier: Classifier;

beforeEach(() => {
  registry = new ManifestRegistry();
  registry.loadFromDirectory('manifests/');
  classifier = new Classifier(registry, { mode: 'strict' } as any);
});

test('POST /repos/x/y/git/refs → ③ (create branch, reversible)', () => {
  const r = classifier.classify({ method: 'POST', urlPath: '/repos/x/y/git/refs', headers: {}, body: {} } as any);
  expect(r.class).toBe('③');
  expect(r.approvalRequired).toBe(false);
});

test('PUT /repos/x/y/pulls/42/merge → ④ with approval gate', () => {
  const r = classifier.classify({ method: 'PUT', urlPath: '/repos/x/y/pulls/42/merge', headers: {}, body: {} } as any);
  expect(r.class).toBe('④');
  expect(r.approvalRequired).toBe(true);
});

test('unknown path → ④ fallback (Preview: conservative)', () => {
  const r = classifier.classify({ method: 'POST', urlPath: '/repos/x/y/weird/thing', headers: {}, body: {} } as any);
  expect(r.class).toBe('④');
  expect(r.reason).toBe('NOT_IN_MANIFEST');
});

test('bypass mode turns off approvalRequired for ④', () => {
  const cls = new Classifier(registry, { mode: 'bypass' } as any);
  const r = cls.classify({ method: 'PUT', urlPath: '/repos/x/y/pulls/1/merge', headers: {}, body: {} } as any);
  expect(r.approvalRequired).toBe(false);
});
```

### 12.3 Fault injection 三场景完整测试代码（见 §5.9）

### 12.4 E2E demo 脚本

```bash
#!/usr/bin/env bash
# demo/run-demo.sh
set -euo pipefail
: "${GITHUB_TOKEN:?set to a fine-grained token on cairn-sandbox-preview}"
: "${OWNER:?set to your GitHub username}"

cairn start --mode strict &
CAIRN_PID=$!
trap "kill $CAIRN_PID" EXIT
sleep 2

LANE="lane_demo_$(date +%s)"

# 4 个 ops：创建 branch / 创建 PR / 加 comment / 加 label
curl -sS -x http://127.0.0.1:7778 -H "x-cairn-lane-id: $LANE" \
     -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" \
     -X POST "https://api.github.com/repos/$OWNER/cairn-sandbox-preview/git/refs" \
     -d "{\"ref\":\"refs/heads/demo-branch-$$\",\"sha\":\"<HEAD_SHA>\"}"

curl -sS -x http://127.0.0.1:7778 -H "x-cairn-lane-id: $LANE" \
     -H "Authorization: Bearer $GITHUB_TOKEN" \
     -X POST "https://api.github.com/repos/$OWNER/cairn-sandbox-preview/pulls" \
     -d "{\"title\":\"demo\",\"head\":\"demo-branch-$$\",\"base\":\"main\"}"

# ...后续 2 ops...

cairn lanes --pipeline demo
cairn revert "$LANE" --dry-run
cairn revert "$LANE" --confirm --json | tee /tmp/cairn-receipt.json

jq -e '.exitCode == 0 and (.receipt.reverted | length) >= 3' /tmp/cairn-receipt.json
```

### 12.5 CI

```yaml
# .github/workflows/ci.yml
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: bun run lint
      - run: bun test tests/unit/
      - run: bun test tests/fault/       # 五件套 gate，任一红 PR 不能 merge
      - name: E2E (only on main)
        if: github.ref == 'refs/heads/main'
        env: { GITHUB_TOKEN: ${{ secrets.CAIRN_SANDBOX_TOKEN }}, OWNER: ${{ secrets.CAIRN_SANDBOX_OWNER }} }
        run: bash demo/run-demo.sh
```

Fault injection 任一红 → PR **不能 merge**。这是 Cairn 产品信任的技术保险丝。

**已知风险 + 应对**
- **E2E 被 GitHub rate limit**：CI 限频到 main branch push-only；PR 只跑 unit + fault mock
- **fault test flakiness**：每个 fault test 跑 3 次，全通过才算绿
- **mock server 差异于真 GitHub**：mock 里内置 GitHub 实际行为 fixture（真 API 响应样本），对照 schema 断言

---

## 13. 开源分发

### 13.1 License

**Apache 2.0** for `src/` / `manifests/` / `demo/` / `tests/`。v0.3 企业版加新代码单独仓库（闭源或 BSL）。

**为什么不 MIT**：Apache 2.0 有显式专利 grant，企业合规好审；Cairn 定位是基建（同类 OpenTelemetry / Temporal），Apache 是事实标准。

### 13.2 README 核心要点

直接引用定位书 §一的三层叙事：

1. **Tagline**："Undo for agents. 让你敢让 AI 干活。"
2. **痛点段**：引用定位书 §二 层 1
3. **架构图**：复用 README 现有 ASCII，简化到 Preview 规模
4. **30 秒 demo GIF**（asciinema → agg）
5. **Install**：`curl -fsSL https://cairn.dev/install.sh | sh`
6. **Status disclosure**：明示 "v0.0.1 Preview — GitHub sandbox only. Not for production."

### 13.3 Screencast 分发节奏

| 时机 | 平台 | 文案重点 |
|---|---|---|
| Day 0 | Twitter/X | 30s 切片 + "5min full video" |
| Day 0 + 6h | Hacker News `Show HN` | "Show HN: Cairn — Undo for AI agents" |
| Day 1 | `r/ClaudeAI`, `r/LangChain`, `r/LocalLLaMA` | 差异化文案 |
| Day 3 | LinkedIn + 中文 DevOps 圈 | 企业角度 |

**目标**：三平台任一达到 Preview 硬指标即 Green。

**已知风险 + 应对**
- **"Undo for agents" 太像营销**：README 第一屏放真实 CLI demo 片段
- **OSS 被大厂 fork 吃掉**：定位书 §六给出五层理由；v0.4 企业版才是护城河

### 13.4 HTTPS MITM 可选轨——已知限制（r1 新增）

§2.3 提到的 opt-in MITM 轨只作为 dogfooder 路径；以下限制在 README / `cairn init --with-mitm` 启动横幅里都会显式声明：

1. **Windows cert store 未自动化**——`cairn init --with-mitm` 在 Windows 下只把 CA 写到 `~/.cairn/ca.pem`，需要用户手动跑 `certutil -addstore -f "Root" %USERPROFILE%\.cairn\ca.pem`（管理员权限）
2. **Node `undici` native fetch**——不读系统 trust store，必须额外设 `NODE_EXTRA_CA_CERTS=~/.cairn/ca.pem`；Cairn preload（`.claude/preload/cairn-undici.mjs`）负责自动注入
3. **Python `certifi`**——标准库 `ssl` 在 macOS 走系统 keychain，但 `requests` / `httpx` 都用 `certifi` 独立 bundle；用户需 `export REQUESTS_CA_BUNDLE=~/.cairn/ca.pem`（Preview 文档提供一键环境片段）
4. **Go `crypto/x509`**——Windows 下不读系统根存储，需要 `SSL_CERT_FILE` 指向 CA
5. **CA 私钥泄漏风险**——`ca.key` 仅 `chmod 600`，且 CA 有效期 90 天；Preview 不做自动轮换，超期需 `cairn init --with-mitm --rotate`
6. **mobile / 移动端 agent** 不在 Preview 支持范围

这些限制均与定位书 §三的 "HTTPS MITM 摩擦作为 known issue 公开" 一致；Preview demo 的默认 mock 轨完全绕开这些问题，新用户 30 秒内可以跑通。

---

## 附录 A：关键 TypeScript 类型定义（≥ 15 个）

```ts
// src/types.ts —— 全量类型冻结契约

/* ====== 基础 id 类型 ====== */
export type LaneId = string & { readonly __brand: 'LaneId' };
export type OpId   = string & { readonly __brand: 'OpId' };
export type CompId = string & { readonly __brand: 'CompId' };

/* ====== 1. Lane ====== */
export type LaneState =
  | 'RECORDED' | 'REVERTING' | 'REVERTED'
  | 'PARTIAL_REVERT' | 'HELD_FOR_HUMAN' | 'FAILED_RETRYABLE';

export interface Lane {
  id: LaneId;
  pipelineId: string;
  agentName: string;
  state: LaneState;
  frozen: boolean;
  attribution: 'high' | 'medium' | 'low' | 'none';
  mode: 'strict' | 'acceptIrreversible' | 'bypass';
  createdAt: number;
  updatedAt: number;
}

export interface NewLane { pipelineId: string; agentName: string; state: LaneState;
  frozen: boolean; attribution: Lane['attribution']; mode: Lane['mode']; }

export interface LaneFilter { pipelineId?: string; state?: LaneState }

export interface LaneLock { laneId: LaneId; pid: number; holder: string /* r1: canonical id */ }

/* ====== 2. Op ====== */
export type OpClass = '①' | '②' | '③' | '④';
export type OpState = 'PENDING_APPROVAL' | 'PASSED' | 'BLOCKED' | 'FAILED';

export interface Op {
  id: OpId;
  laneId: LaneId;
  seq: number;
  method: string;
  url: string;
  urlPath: string;
  requestBody?: Uint8Array | null;
  responseStatus?: number | null;
  responseBody?: Uint8Array | null;
  beforeImage?: BeforeImage | null;
  classification: OpClass;
  state: OpState;
  manifestSnapshot?: ManifestEntry | null;
  classifierResult?: ClassifierResult;        // r1: 持久化字段（ops.classifier_result_json）
  classifierResultCache?: ClassifierResult;   // r1: runtime 别名，保留向后兼容
  requestSnapshot?: RequestSnapshot;          // r1: ops.request_snapshot_json
  createdAt: number;
}

export interface NewOp { method: string; url: string; urlPath: string;
  requestBody?: Uint8Array; classification: OpClass; state: OpState;
  beforeImage?: BeforeImage; manifestSnapshot?: ManifestEntry }

/* ====== 3. Compensation ====== */
export type CompState =
  | 'PENDING' | 'RUNNING' | 'SUCCESS'
  | 'PARTIAL' | 'VERIFY_MISMATCH' | 'INFRA_ERR' | 'MANUAL_GATE';

export interface Compensation {
  id: CompId;
  opId: OpId;
  stepIdx: number;
  action: string;
  plan: CompensationStepPlan;
  state: CompState;
  attempt: number;
  lastError?: string;
  startedAt?: number;
  endedAt?: number;
}

export interface CompensationStepPlan {
  method: string;
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
  covers: string[];
  bestEffort?: boolean;
  /** r1: 三型 union — etag / version-check / field-match，见附录 A §18 */
  optimisticLock?: OptLockSpec;
}

export interface CompensationStep {
  id: CompId;
  opId: OpId;
  stepIdx: number;
  action: string;
  plan: CompensationStepPlan;
  state: CompState;
  attempt: number;
  covers: string[];
}

export interface CompensationPlan { laneId: LaneId; steps: CompensationStep[] }

/* ====== 4. Receipt ====== */
/**
 * Receipt 作为独立 artifact（下载、审计、归档），字段都是 self-contained。
 * laneId / agentId / agentName / pipelineId 是 denormalized from Lane——
 * 允许 receipt 脱离 lanes 表单独解读；若 lane 被删除，receipt 仍可追溯到哪个 agent 做的。
 *
 * 关键不变量：
 * - **不要**在 Receipt 上加 string `status` 字段——exitCode 是唯一真源，
 *   人类可读字符串通过 exitCodeToString() helper 在展示层获得。
 * - **不要**在 Receipt 上加 top-level `haltedAt`——中断位置由 failed[0].stepIdx 提供。
 */
export interface Receipt {
  // Lane 上下文（denormalized，让 Receipt self-contained）
  laneId: LaneId;
  agentId: string;           // denormalized from Lane
  agentName: string;         // denormalized from Lane
  pipelineId?: string;       // denormalized from Lane（若 lane 属于某 pipeline）

  // 状态与结果
  exitCode: 0 | 2 | 3 | 4 | 5;
  reverted: { opId: OpId; stepIdx: number; covers: string[]; at: string }[];
  failed: {
    opId: OpId; stepIdx: number;
    code: 'INCOMPLETE_BEFORE_IMAGE' | 'CONFLICT' | 'INFRA_ERR' | 'MANUAL_GATE';
    msg: string;
    gaps?: string[];
  }[];
  irreversibleSideEffects: IrreversibleSideEffect[];

  // 元数据
  timings: { startedAt: string; endedAt: string; wallMs: number };
  attribution: { confidence: 'high' | 'medium' | 'low' | 'none' };
  engineVersion: string;     // 如 "cairn/0.0.1-r2"，用于 receipt 跨版本追溯
  generatedAt: number;       // epoch ms
  idempotencyKey?: string;
}

/* ====== 5. Irreversible tail ====== */
export interface IrreversibleSideEffect {
  kind: string;
  detectable: boolean;
  evidence?: unknown;
  via?: string;
}

/* ====== 6. ClassifierResult ====== */
export interface ClassifierResult {
  class: OpClass;
  reason: string;
  entry?: ManifestEntry;
  approvalRequired: boolean;
  acceptedIrreversible: boolean;
}

export interface ParsedRequest {
  method: string;
  url: string;
  urlPath: string;
  headers: Record<string, string>;
  body?: unknown;
  upstreamBase?: string;
  remotePort?: number;
}

/* ====== 7. Manifest types ====== */
export interface ManifestFile {
  adapter: string;
  api_version?: string;
  base_url: string;
  preview_only: boolean;
  entries: ManifestEntry[];
}

export interface ManifestEntry {
  adapter?: string;
  method: string;
  path: string;
  class: OpClass;
  classReason: string;
  beforeImage: {
    captureVia: string | null;
    extraLatencyBudgetMs: number;
    coverageGaps: { field: string; reason?: string }[];
  };
  undoStrategy: {
    tier: 'L0-pure' | 'L1-bounded' | 'L2-cross-system' | 'L3-irreversible-tail';
    compensatorChain: CompensationStepPlan[];
    unreversibleTail?: { kind: string; detectable: boolean; via?: string }[];
  };
  requiresApprovalWhen: Array<{ always?: boolean; expr?: string }>;
}

/* ====== 8. Mode ====== */
export interface ModeConfig {
  mode: 'strict' | 'acceptIrreversible' | 'bypass';
  proxyPort?: number;
  approvalTimeoutSec: number;
  notify?: { on_approval_pending?: string };
  perLane?: Record<string, Partial<ModeConfig>>;
  github?: { apiVersion: string; sandboxRepo?: string };
  logging?: { level: 'debug'|'info'|'warn'|'error'; redact: string[] };
}

/* ====== 9. Attribution ====== */
export interface IncomingRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  remoteAddress: string;
  remotePort: number;
}

export interface LaneResolutionResult {
  laneId: LaneId | null;
  confidence: 'high' | 'medium' | 'low' | 'none';
  source: 'layer1' | 'layer2' | 'layer3' | 'conflict' | 'none';
}

export interface SubagentFrontmatter {
  name: string;
  description?: string;
  env?: Record<string, string>;
  mcpServers?: Record<string, { url?: string; command?: string; args?: string[]; headers?: Record<string, string> }>;
  hooks?: Record<string, string | string[]>;
  [k: string]: unknown;
}

export interface HookPayload { pid: number; laneId: LaneId; agent: string; ts: number }

/* ====== 10. State machine ====== */
export type StepState =
  | 'PENDING' | 'RUNNING' | 'SUCCESS' | 'PARTIAL' | 'VERIFY_MISMATCH' | 'INFRA_ERR' | 'MANUAL_GATE';

export type StepEvent =
  | { kind: 'START' }
  | { kind: 'EXIT_0' }
  | { kind: 'EXIT_2' }
  | { kind: 'EXIT_3' }
  | { kind: 'EXIT_4' }
  | { kind: 'EXIT_5' }
  | { kind: 'RETRY' }
  | { kind: 'ABANDON' };

export type LaneEvent =
  | { kind: 'REVERT_START' }
  | { kind: 'ALL_SUCCESS' }
  | { kind: 'ANY_FAIL' }
  | { kind: 'INFRA_EXHAUSTED' }
  | { kind: 'MANUAL_GATE' }
  | { kind: 'APPROVE' }
  | { kind: 'DENY' };

/* ====== 11. Result helpers ====== */
export interface StepResult {
  status: 'SUCCESS' | 'FAIL';
  step: CompensationStep;
  at: string;
  dryRun?: boolean;
  errorCode?: 'INCOMPLETE_BEFORE_IMAGE' | 'CONFLICT' | 'INFRA_ERR' | 'MANUAL_GATE';
  errorMsg?: string;
}

export interface StepError { code: string; msg: string; attempt: number }

export interface InvariantError { kind: 'INCOMPLETE_BEFORE_IMAGE'; opId: OpId; gaps: string[]; message: string }

/* ====== 12. Revert context ====== */
export interface RevertContext {
  laneId: LaneId;
  startedAt: string;
  dryRun: boolean;
  completed: StepResult[];
  failed: Receipt['failed'][number] | null;
  irreversibleTail: IrreversibleSideEffect[];
  attributionConfidence?: 'high' | 'medium' | 'low' | 'none';
}

/* ====== 13. Before-image ====== */
export interface BeforeImage {
  fetchedAt: number;
  body: unknown;
  etag?: string;
  coverageGaps?: string[];
}

/* ====== 14. Plan action ====== */
export type PlanAction = 'CONTINUE' | 'RETRY' | 'ABORT' | 'SKIP_BEST_EFFORT';

/* ====== 15. CairnError (单独 class 但作为契约纳入) ====== */
export class CairnError extends Error {
  constructor(public code: string, public details: Record<string, unknown> = {}) {
    super(`[${code}] ${JSON.stringify(details)}`);
  }
}

/* ====== 16. r1 新增：Template resolution ====== */
export interface ResolutionContext {
  /** path template 匹配结果（e.g. { owner: 'acme', repo: 'web', number: '42' }） */
  path: Record<string, string>;
  /** forward 请求 body（已 JSON.parse）；nullable when forward body is absent */
  request?: Record<string, unknown>;
  /** forward 上游响应 body（已 JSON.parse） */
  response?: Record<string, unknown>;
  /** captureBeforeImage() 抓的 GET 快照 body（flat merge 了 etag） */
  before_image?: Record<string, unknown>;
}

/* ====== 17. r1 新增：RequestSnapshot (strict mode approval gate 用) ====== */
export interface RequestSnapshot {
  method: string;                         // "POST"
  url: string;                            // 完整绝对 URL
  headers: Record<string, string>;        // Authorization 已替换为 "<redacted>"
  body?: unknown;                         // 解析后的 JSON；若不是 JSON 存 bodyEncoding='raw'
  bodyEncoding?: 'json' | 'raw';
  receivedAt: number;                     // epoch ms
  clientConnectionId: string;             // ulid，对应 proxy 内部 socket Map
}

/* ====== 18. r1 新增：Optimistic Lock 三型 union + Result ====== */
export type OptLockSpec =
  | { type: 'etag';          value: string }                          // ${before_image.etag}
  | { type: 'version-check'; field: string; expected: string }        // ${before_image.updated_at}
  | { type: 'field-match';   probe_url: string;
      compare_strategy: 'must_contain' | 'must_not_contain' | 'exact_match';
      compare_value: string };

export interface FieldMatchSpec extends Extract<OptLockSpec, { type: 'field-match' }> {}

export type OptLockResult =
  | { status: 'ok' }
  | { status: 'conflict'; detail: string }
  | { status: 'probe_failed'; httpStatus: number };

/* ====== 19. r1 新增：LaneLock holder 字符串化 ====== */
// 覆盖 §2 的旧 LaneLock；r1 同时带 pid（legacy）与 holder（canonical）字段
// 注：这里写在一起是为了让扫描工具能看到；实际源码里与 §2 合并。
export interface LaneLockR1 extends LaneLock {
  holder: string;    // `${pid}@${hostname}` 或 daemon uuid
}
```

---

## 附录 B：GitHub Manifest YAML 完整 + 本地 adapter 模板

### B.1 `manifests/github.yaml`（8 端点全量）

```yaml
# manifests/github.yaml
adapter: github
api_version: "2022-11-28"
base_url: "https://api.github.com"
preview_only: true

entries:

  # r1 语法：path 上的 {owner} / {number} 等仅供 Classifier path-match；
  # 其余字段（url / body / optimistic_lock）使用 ${namespace.dotted.path}（§4.4）。

  # 1. 创建 branch
  - method: POST
    path: /repos/{owner}/{repo}/git/refs
    class: "③"
    class_reason: "branch creation is fully reversible via DELETE ref"
    before_image:
      capture_via: null
      coverage_gaps: [{ field: "object.sha", reason: "server-confirmed" }]
    undo_strategy:
      tier: L0-pure
      compensator_chain:
        - action: "github:delete-ref"
          method: DELETE
          url: "/repos/${path.owner}/${path.repo}/git/refs/heads/${path.ref_short}"
          covers: ["ref", "object.sha"]
    requires_approval_when: []

  # 2. 创建 PR
  - method: POST
    path: /repos/{owner}/{repo}/pulls
    class: "③"
    class_reason: "PR can be closed + head branch deleted"
    before_image:
      capture_via: null
      coverage_gaps:
        - { field: "created_at" }
        - { field: "number" }
        - { field: "node_id" }
    undo_strategy:
      tier: L1-bounded
      compensator_chain:
        - action: "github:patch-pr-state"
          method: PATCH
          url: "/repos/${path.owner}/${path.repo}/pulls/${response.number}"
          body: { state: closed }
          covers: ["state"]
        - action: "github:delete-ref"
          method: DELETE
          url: "/repos/${path.owner}/${path.repo}/git/refs/heads/${request.head}"
          covers: ["ref"]
          best_effort: true
    requires_approval_when: []

  # 3. 关闭 PR (PATCH state=closed)
  - method: PATCH
    path: /repos/{owner}/{repo}/pulls/{number}
    class: "③"
    class_reason: "reversible via PATCH state=open"
    before_image:
      capture_via: "GET /repos/{owner}/{repo}/pulls/{number}"
      extra_latency_budget_ms: 500
      coverage_gaps: [{ field: "updated_at" }]
    undo_strategy:
      tier: L0-pure
      compensator_chain:
        - action: "github:patch-pr-state"
          method: PATCH
          url: "/repos/${path.owner}/${path.repo}/pulls/${path.number}"
          body:
            state: "${before_image.state}"
            title: "${before_image.title}"
            body:  "${before_image.body}"
          covers: ["state", "title", "body"]
          optimistic_lock:
            type: "etag"
            value: "${before_image.etag}"
    requires_approval_when: []

  # 4. 创建 issue
  - method: POST
    path: /repos/{owner}/{repo}/issues
    class: "③"
    class_reason: "cannot hard-delete issue, but can close"
    before_image:
      capture_via: null
      coverage_gaps: [{ field: "number" }, { field: "created_at" }]
    undo_strategy:
      tier: L1-bounded
      compensator_chain:
        - action: "github:patch-issue-state"
          method: PATCH
          url: "/repos/${path.owner}/${path.repo}/issues/${response.number}"
          body: { state: closed }
          covers: ["state"]
      unreversible_tail:
        - { kind: "issue-notification-email", detectable: false }
    requires_approval_when: []

  # 5. 评论
  - method: POST
    path: /repos/{owner}/{repo}/issues/{issue_number}/comments
    class: "③"
    class_reason: "comments can be deleted"
    before_image:
      capture_via: null
      coverage_gaps: [{ field: "id" }, { field: "created_at" }]
    undo_strategy:
      tier: L0-pure
      compensator_chain:
        - action: "github:delete-comment"
          method: DELETE
          url: "/repos/${path.owner}/${path.repo}/issues/comments/${response.id}"
          covers: ["body", "id"]
      unreversible_tail:
        - { kind: "comment-notification-email", detectable: false }
    requires_approval_when: []

  # 6. 加 label  — r1 field-match optimistic_lock 完整体（§10.3）
  - method: POST
    path: /repos/{owner}/{repo}/issues/{issue_number}/labels
    class: "③"
    class_reason: "labels can be removed one-by-one"
    before_image:
      capture_via: "GET /repos/{owner}/{repo}/issues/{issue_number}/labels"
      extra_latency_budget_ms: 400
      coverage_gaps: []
    undo_strategy:
      tier: L0-pure
      compensator_chain:
        - action: "github:delete-label"
          method: DELETE
          url: "/repos/${path.owner}/${path.repo}/issues/${path.issue_number}/labels/${request.labels.0}"
          covers: ["labels"]
          optimistic_lock:
            type: "field-match"
            probe_url: "GET /repos/${path.owner}/${path.repo}/issues/${path.issue_number}/labels"
            compare_strategy: "must_contain"
            compare_value: "${request.labels.0}"
    requires_approval_when: []

  # 7. merge PR (④)
  - method: PUT
    path: /repos/{owner}/{repo}/pulls/{number}/merge
    class: "④"
    class_reason: "merge triggers CI, webhook fan-out, deploy pipelines"
    before_image:
      capture_via: "GET /repos/{owner}/{repo}/pulls/{number}"
      extra_latency_budget_ms: 500
      coverage_gaps: []
    undo_strategy:
      tier: L3-irreversible-tail
      compensator_chain: []
      unreversible_tail:
        - { kind: "ci-run", detectable: true, via: "GET /repos/${path.owner}/${path.repo}/actions/runs?head_sha=${response.sha}" }
        - { kind: "webhook-delivery", detectable: true, via: "GET /repos/${path.owner}/${path.repo}/hooks" }
        - { kind: "downstream-deploy", detectable: false }
    requires_approval_when: [{ always: true }]

  # 8. 删 branch (④)
  - method: DELETE
    path: /repos/{owner}/{repo}/git/refs/heads/{branch}
    class: "④"
    class_reason: "branch deletion is hard-delete; PR base references orphan"
    before_image:
      capture_via: "GET /repos/{owner}/{repo}/git/refs/heads/{branch}"
      extra_latency_budget_ms: 400
      coverage_gaps: []
    undo_strategy:
      tier: L3-irreversible-tail
      compensator_chain:
        - action: "github:create-ref"
          method: POST
          url: "/repos/${path.owner}/${path.repo}/git/refs"
          body:
            ref: "refs/heads/${path.branch}"
            sha: "${before_image.object.sha}"
          covers: ["ref", "object.sha"]
          best_effort: true
      unreversible_tail:
        - { kind: "PR-base-orphan", detectable: true, via: "GET /repos/${path.owner}/${path.repo}/pulls?base=${path.branch}" }
        - { kind: "protected-branch-rules", detectable: false }
    requires_approval_when: [{ always: true }]
```

### B.2 本地 HTTP adapter manifest 示例（给未来 adapter 作者参考）

```yaml
# manifests/local-http.yaml  (未启用；v0.1 MVP 时加入)
adapter: local-http
base_url: "http://127.0.0.1:3000"
preview_only: false

entries:
  - method: POST
    path: /api/items
    class: "③"
    class_reason: "generic POST with returned id → DELETE by id"
    before_image:
      capture_via: null
      coverage_gaps: [{ field: "id" }, { field: "created_at" }]
    undo_strategy:
      tier: L0-pure
      compensator_chain:
        - action: "http:delete-by-id"
          method: DELETE
          url: "/api/items/${response.id}"
          covers: ["*"]
    requires_approval_when: []

  - method: PUT
    path: /api/items/{id}
    class: "③"
    class_reason: "PUT overwrites; revert by PUT before-image"
    before_image:
      capture_via: "GET /api/items/{id}"
      extra_latency_budget_ms: 300
    undo_strategy:
      tier: L0-pure
      compensator_chain:
        - action: "http:put-before-image"
          method: PUT
          url: "/api/items/${path.id}"
          body: "${before_image.body}"
          covers: ["*"]
          optimistic_lock:
            type: "etag"
            value: "${before_image.etag}"
    requires_approval_when: []

  - method: DELETE
    path: /api/items/{id}
    class: "④"
    class_reason: "hard-delete; can attempt re-POST but new id"
    before_image:
      capture_via: "GET /api/items/{id}"
    undo_strategy:
      tier: L3-irreversible-tail
      compensator_chain:
        - action: "http:post-revive"
          method: POST
          url: "/api/items"
          body: "${before_image.body}"
          covers: ["*"]
          best_effort: true
      unreversible_tail:
        - { kind: "new-id-assigned", detectable: true, via: "response.id" }
    requires_approval_when: [{ always: true }]
```

---

## 附录 C：3 轮 POC 复现命令 + 关键数据

### Round 1 — Lane attribution

- **位置**：`D:\lll\cairn\cairn-poc\`（顶层）
- **核心文件**：`proxy.js`、`echo-server.js`、`client-node.mjs`、`client-python.py`、`pid-lookup.mjs`
- **findings**：`D:\lll\cairn\cairn-poc\RESULTS.md`
- **复现**：
  ```bash
  cd D:/lll/cairn/cairn-poc
  bun install
  node echo-server.js &           # 18081
  node proxy.js &                 # 18080
  node client-node.mjs            # 期望：proxy.log 里 header 可见
  node pid-lookup.mjs &           # 18090
  curl -x http://127.0.0.1:18090 http://127.0.0.1:18081/
  # 观察 pid-lookup 的命中率（POC 报告 6/6）
  ```
- **关键数据**：Layer 3 延迟 52-179ms；Node native fetch 不读 `HTTP_PROXY` 是 real issue，需 undici monkey-patch

### Round 2 — Classification

- **位置**：分类的判断逻辑在 compensator POC 每个子目录的 `RESULT.md` 里交叉验证
- **核心 findings**：rule-only 准确率 43-57% → 必须 L0 manifest；见定位书 §三 + 本文档 §4
- **Preview 操作**：不单独复现，manifest 逻辑在 `src/classifier/` 单测中覆盖

### Round 3 — Compensator engine 五件套

- **位置**：`D:\lll\cairn\cairn-poc\compensator\`
- **RESULTS.md**：`D:\lll\cairn\cairn-poc\compensator\FAULT_INJECTION\FAULT_RESULTS.md`（**7 场景 5 naive fail 的实测表**）
- **STATE_MACHINE.txt**：`D:\lll\cairn\cairn-poc\compensator\FAULT_INJECTION\STATE_MACHINE.txt`（**Preview 状态机直接沿用**）
- **子 POC 目录**：
  - `01-github-issue/`、`02-notion-page/`、`03-postgres-update/`、`04-jira-bulk/`、`05-stripe-subscription/`、`06-s3-multipart/`、`07-github-merge/`、`08-vercel-deploy/`
- **Preview 取用**：
  - F-invariant 直接移植 `FAULT_INJECTION/f1a-github-before-image-missing-labels.js`
  - F-optlock 参考 `f1c-sql-concurrent-write.js` 改写成 GitHub If-Match 版
  - F-midstep 参考 `f2a-jira-bulk-revert-step-fail.js` 改写成 PR close + delete branch 多步失败
- **复现**：
  ```bash
  cd D:/lll/cairn/cairn-poc/compensator/01-github-issue
  bash test.sh
  # 期望：revert 完成，lane state REVERTED；FAULT_RESULTS.md 有对照
  ```
- **关键数据**：Before-image P50 +34-45ms local / 100-400ms 真 GitHub API；5/7 naive 场景静默撒谎——**这就是五件套存在的原因**

---

*文档结束。有不清楚的点先在本仓库 issue 区问，不要靠推断 ship 代码。*
