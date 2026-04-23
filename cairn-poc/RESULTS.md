# Cairn PoC — Header Attribution via Local Forward Proxy

Author: Subagent C
Date: 2026-04-21
Host: Windows 11 Pro + Git Bash, Node v24.14.0, Python 3.14.0, curl 8.16.0 (Schannel)
Artifacts in `D:\lll\cairn\cairn-poc\`:
- `proxy.js` — forward proxy on 127.0.0.1:18080 (logs every request header + `remoteAddress:remotePort`)
- `echo-server.js` — target server on 127.0.0.1:18081 (echoes headers + its own env `CAIRN_LANE_ID`)
- `client-node.mjs` — Node client (native `fetch` / undici, with or without ProxyAgent dispatcher)
- `client-python.py` — Python client (`httpx` and `requests`)
- `pid-lookup.mjs` — inline proxy on 18090 that does a `netstat -ano` lookup for the client port to return its PID
- `proxy.log` — last run's captured headers (JSON lines)

No `gh` CLI installed → skipped. No Go/Rust → skipped (not requested to install).

## Experiment 1 — local forward proxy

`proxy.js` is a vanilla Node HTTP proxy: it reads absolute-form `clientReq.url`, makes an upstream `http.request`, streams both directions, and also implements `CONNECT` tunneling for HTTPS. Every incoming request has its full headers + the client socket's `remoteAddress:remotePort` written to stdout and appended to `proxy.log` as a JSON line. Echo server returns the headers it sees plus `process.env.CAIRN_LANE_ID` (so we can distinguish "header" from "env") as JSON.

Both up and listening (verified with `netstat -ano | grep 1808`):
```
TCP 127.0.0.1:18080 LISTENING (proxy, PID 22680)
TCP 127.0.0.1:18081 LISTENING (echo,  PID 23428)
```

## Experiment 2 — explicit `x-cairn-lane-id` header transmission

Matrix — each cell = "did the proxy actually receive the request AND see the header?" (verified from `proxy.log`, not just echo response):

| Client | (a) `HTTP_PROXY` env | (b) explicit proxy API | Direct (no proxy) |
| --- | --- | --- | --- |
| `curl` (Win, Schannel) | **Skipped, target localhost** | **Skipped, target localhost** | header arrives at echo (not via proxy) |
| `curl --proxy … --noproxy ''` | OK | OK | n/a |
| Node `fetch` / undici | **NOT auto-read** | OK via `ProxyAgent` dispatcher — but uses CONNECT tunnel | header arrives at echo (direct) |
| Python `httpx` | **Skipped for 127.0.0.1 unless `NO_PROXY=`** | OK via `proxy=` kwarg | works direct |
| Python `requests` | Same as httpx — `should_bypass_proxies` trips | OK via `proxies=` kwarg | works direct |
| `gh` CLI | — not installed, skipped — | | |

Key gotchas:
1. **Windows curl (and Python stdlib / httpx / requests) bypass proxy for `localhost` and `127.0.0.1` by default.** `HTTP_PROXY=http://127.0.0.1:18080` alone is NOT sufficient. You must either target a non-loopback IP, or set `NO_PROXY=` (empty) / `--noproxy ''`. For a production Cairn proxy this isn't an issue because the target (Anthropic/OpenAI APIs) is not localhost, but during local dev testing it was a major confounder.
2. **Node 24 native `fetch` (undici) does NOT read `HTTP_PROXY` env at all.** The request went direct, the proxy never saw it. You must either (a) pass a `ProxyAgent` dispatcher explicitly, (b) set `globalDispatcher`, or (c) in newer Node use the `NODE_USE_ENV_PROXY=1` env flag. Direct evidence: Scenario N1 set `HTTP_PROXY=http://127.0.0.1:18080` and `proxy.log` stayed empty for that run.
3. When you DO use undici's `ProxyAgent` with an `http://` URL, it issues a `CONNECT 127.0.0.1:18081` tunnel rather than sending the origin-form request to the proxy. That means **the proxy can only see the TCP tunnel target host:port, not the HTTP headers**. This is a material finding for Cairn: if Cairn's agent SDK uses undici dispatcher-style proxy configuration, the proxy loses the ability to inspect / rewrite headers unless it MITMs TLS or a custom `Agent` sends origin-form.

Log sample (curl via `--proxy`, with IP target and `--noproxy ''`):
```
{"kind":"http_request","method":"GET","url":"http://127.0.0.1:18081/c1","remoteAddress":"127.0.0.1","remotePort":63954,"headers":{"host":"127.0.0.1:18081","user-agent":"curl/8.16.0","accept":"*/*","proxy-connection":"Keep-Alive","x-cairn-lane-id":"test-123"}}
```

## Experiment 3 — env-var auto-injection

Setup in every case: set `CAIRN_LANE_ID=lane-abc` in parent env, child makes HTTP request, DO NOT add `x-cairn-lane-id` header explicitly, check both the proxy log and the echo response.

| Client | Auto-injected `x-cairn-lane-id`? |
| --- | --- |
| `curl` | **No** (proxy saw request, no lane header; see scenario C3) |
| Node native `fetch` | **No** |
| Python `httpx` | **No** |
| Python `requests` | **No** |

Result is uniform: **no mainstream HTTP client auto-reads an arbitrary env var and promotes it to a request header.** This was expected, and the experiment confirms the predicted baseline. Log sample from C3:
```
{"kind":"http_request","url":"http://127.0.0.1:18081/c3","headers":{"host":"127.0.0.1:18081","user-agent":"curl/8.16.0","proxy-connection":"Keep-Alive"}}  # no x-cairn-lane-id
```

Implication for Cairn: **you cannot rely on "just set `CAIRN_LANE_ID` in the subagent's env" to get attribution.** Attribution must come from either (a) a shim/wrapper that the agent code explicitly calls, (b) an SDK patch that auto-injects, or (c) source-side connection metadata (see Experiment 4).

## Experiment 4 — source connection PID backtracking

`pid-lookup.mjs` runs a proxy on 18090. On every incoming request it captures `socket.remotePort`, then spawns `netstat -ano` and scans for the line where the local address ends with `:<port>` to get the owning PID. Each measurement logs the total lookup latency.

Raw runs (5 × curl, 1 × python urllib):
```
remotePort=63456 → PID 18452  latency=66ms   (curl-1)
remotePort=63457 → PID 10304  latency=55ms   (curl-2)
remotePort=63458 → PID 7736   latency=54ms   (curl-3)
remotePort=63459 → PID 19228  latency=52ms   (curl-4)
remotePort=63460 → PID 18060  latency=52ms   (curl-5)
remotePort=63461 → PID 24952  latency=179ms  (python)
```

- **Hit rate: 6/6 = 100 %** for this sample. The ephemeral client port was still in `ESTABLISHED` state while the proxy processed the first byte, which is why lookup at request arrival always hit.
- **netstat latency: ~52–66ms (curl), 179ms (python).** High variance, but usable for a first-request gate. For pipelined requests over a reused keep-alive connection, the cost amortizes (one lookup per connection, not per request), so the proxy can cache `remotePort → PID` per connection.
- Also measured `Get-NetTCPConnection -LocalPort 18090` via PowerShell 5.1: **1787 ms**. Much slower — DO NOT use the PS cmdlet. Raw `netstat -ano` is the right call on Windows.
- Follow-ons worth exploring but out of scope: (i) Windows `GetExtendedTcpTable` Win32 API for sub-millisecond lookups without shelling out; (ii) `psutil.net_connections()` on Python — likely similar speed.

**Attribution viability**: because loopback ephemeral ports are unique per connection, and Cairn's subagents run as distinct PIDs, `remotePort → PID` is a clean 1-to-1 mapping. Combined with a PID→lane map Cairn maintains when it spawns each subagent, this gives **lane attribution without client cooperation** — as long as the client actually routes through the proxy.

## Experiment 5 — bypass / blind-spot scenarios

Confirmed with live traffic:

| Scenario | Proxy sees it? | Consequence |
| --- | --- | --- |
| **B1** Node native `fetch` + `HTTP_PROXY` env (no dispatcher) | No | `proxy.log` remained empty. Silently bypasses any Cairn proxy. |
| **B2** Python httpx/requests + `HTTP_PROXY` env, target is `localhost`/`127.0.0.1` | No | Default `should_bypass_proxies` trips. |
| **B3** Direct HTTPS without proxy env and without wrapper | No | Classic. |
| MCP stdio / unix-socket / named-pipe traffic | n/a | Never TCP → never hits an HTTP proxy. Pure blind spot unless Cairn also intercepts stdio. |
| HTTPS CONNECT tunneling through Cairn proxy | Only sees host:port | Payload is TLS-encrypted end-to-end. Header-based attribution requires either TLS MITM with Cairn's own CA, OR connection-metadata attribution (Experiment 4). |
| undici `ProxyAgent` for `http://` URLs | Only sees CONNECT target | Same issue — even for plain HTTP, undici uses CONNECT tunneling. Header inspection lost. |

## Final judgment for Cairn

**Reliable cases for header-based attribution:**
- Clients that are explicitly configured by Cairn's agent-runner to both (i) route through the proxy AND (ii) add the lane header themselves (e.g. a wrapped Anthropic/OpenAI SDK client Cairn controls).
- `curl` / `fetch` commands emitted by a tool-use step where Cairn injects `-H x-cairn-lane-id` and `--proxy …` explicitly.
- Python HTTP libraries (`httpx`, `requests`) when Cairn either patches the client globally or sets `HTTP_PROXY` + `NO_PROXY=` + cooperates with code that adds the header. BUT this still requires the header to be added by someone — env alone doesn't do it.

**Unreliable / broken cases:**
- Node native `fetch` with only `HTTP_PROXY` env set — **silently bypasses the proxy**. Must use `ProxyAgent` or `NODE_USE_ENV_PROXY=1`. For CC subagents that write ad-hoc Node code, this is a real risk.
- Any HTTP client with Windows default `no_proxy` semantics talking to another process on localhost.
- HTTPS traffic through a CONNECT-tunneling proxy (and undici always uses CONNECT, even for HTTP) — the header is invisible to the proxy. End-to-end TLS means **header-based attribution is impossible at the proxy layer** unless Cairn becomes a TLS-terminating MITM, which is a non-trivial ops lift.
- MCP stdio / named-pipe / unix-socket transports — not HTTP at all, complete blind spot.
- Any client Cairn didn't wrap and didn't tell about the proxy — bypass is trivial and silent.

**Actionable implications:**
1. **Env-var auto-injection is a dead end.** All major clients confirm: `CAIRN_LANE_ID` in env does nothing by itself. Cairn must ship a shim / wrapper (e.g. a preload `dispatcher` for Node undici, a `httpx.Client` factory, a wrapped `Anthropic()` constructor) or patch clients in place.
2. **Connection-metadata attribution (remotePort → PID → lane) is the only reliable, client-agnostic mechanism.** Experiment 4 shows it works end-to-end on Windows at ~50ms per first request, with caching per connection. This should be Cairn's primary attribution path; headers become an optional reinforcement for cross-process / cross-machine cases.
3. **Cairn MUST TLS-terminate if it wants to read / rewrite headers on real API traffic.** Otherwise all outgoing requests to api.anthropic.com are CONNECT tunnels and the proxy only knows "someone in PID X connected to api.anthropic.com:443". That may actually be enough for lane attribution (PID→lane) without reading headers, but NOT enough for per-request telemetry, tool-use labeling, or selective rewriting.
4. **Document the Node-undici-env pitfall prominently.** A developer setting `HTTP_PROXY` in their shell and assuming Cairn captures their test calls will silently get wrong / missing data.
5. **MCP stdio is an explicit out-of-scope item** for the proxy. If MCP call attribution matters, it needs a separate capture mechanism (wrap the MCP client, or trace stdio).

---
Raw logs preserved in `proxy.log`; scripts under `cairn-poc/`. All experiments were actually executed on the local machine during this session (timestamps in `proxy.log` attest).
