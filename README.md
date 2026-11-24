# dsh-memore-bridge

把 [Mirror（Memore）](https://github.com/ACAneSe1/Mirror) 的记录库接给 DeepSeek Harness 的 agent：检索、读取、写回提案，
**全部直连手机上的 App**，读到的永远是当前数据，没有副本、不需要同步。

## 它是什么

Mirror 是一个纯本地的 Android 记录工具。它自带一个局域网 HTTP 服务（App 里叫「Agent 连接」），
这个插件就是那个服务的客户端，把它的接口包成 agent 能调的工具。

## 前置

1. 手机上装 Mirror，进「设置 → Agent 连接」启动服务，复制 token。
2. 电脑和手机在同一个局域网（或同一个 Tailscale/ZeroTier 网络）。
3. DSH 0.2.x。

## 安装

```bash
dsh plugin --profile <你的 profile> add <本目录或 tgz 路径>
```

装完在「设置 → 插件」里能看到 `memore-bridge`。

## 配置

**推荐：在 App 里点一下，回 DSH 里粘一下。**

1. App 的「设置 → Agent 连接」启动服务后，点「复制连接串」，得到一整串：
   `memore://<手机 IP>:8790?token=…`
2. DSH →「设置 → 插件配置 → memore-bridge」→ 把整串粘进 `url` → 保存。

两种等价写法：

- **环境变量**：`MEMORE_AGENT_URL=memore://<手机 IP>:8790?token=…`
- **旧版 JSON**（仍兼容，优先级最低）：`~/.dsh/memore-agent.json`

```json
{
  "base": "http://<手机 IP>:8790",
  "token": "<App 里复制的 token>",
  "fallbackBase": "http://127.0.0.1:18790"
}
```

`fallbackBase` 是可选的，用于 USB 端口转发（`adb reverse tcp:18790 tcp:8790`）或本机代理。

配置优先级：设置页 → 环境变量 `MEMORE_AGENT_URL` → JSON 文件。三处都没配时，工具会直接告诉你下一步该做什么，而不是抛一个 `ECONNREFUSED`。

## 工具

| 工具 | 作用 |
|---|---|
| `memore_search` / `memore_recent` / `memore_get` | 检索、最近记录、按 id 取全文 |
| `memore_facets` / `memore_concepts` / `memore_concept_records` | 目录、概念清单、某概念下的记录 |
| `memore_neighbors` | 一条记录的关联、增修链、同标签记录 |
| `memore_digest` / `memore_stats` / `memore_suggest` | 压缩上下文、时间聚合、整理候选 |
| `memore_act` / `memore_actions` / `memore_act_status` / `memore_undo` | 写回：提交动作、查看队列、查状态、撤回 |
| `memore_health` | 端口、运行时长、记录数 |

写回是**提案制**：`memore_act` 默认进 App 的待批队列，用户在 App 里批准才真正落库。
所以 agent 不会背着你改库。

## 注意

- token 等于你库的读写权限，别提交到仓库、别贴进截图。配置文件的推荐权限是仅当前用户可读。
- 服务只应监听的局域网地址；不要把端口暴露到公网。
- 工具描述和 `SKILL.md` 是给模型看的行为约定，改它们等于改 agent 的用法，改完建议重装一次。

## 许可

MIT，见仓库根目录的 [LICENSE](LICENSE)。
