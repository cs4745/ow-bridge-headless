# OW Bridge Headless

把 OpenCode 免费模型暴露为 **OpenAI 兼容 API** 的无 GUI 代理。开箱即用：装依赖、启动、拿 token、调用。

> 这是从 [louchi1984-coder/ow-bridge](https://github.com/louchi1984-coder/ow-bridge) 抽出的纯 headless 版本，不含 Electron 桌面端，只依赖 `tar` + `undici` 两个纯 JS 包。

## 来源与致谢

本项目是 **[louchi1984-coder/ow-bridge](https://github.com/louchi1984-coder/ow-bridge)** 的 **headless（无界面）衍生版**，并非原创，在此向原作者致敬。

- **原作者**：`louchi1984-coder`（抖音 / 视频号：@娄老师说的对）
- **原项目**：<https://github.com/louchi1984-coder/ow-bridge>
- **本仓库的改动**：移除原项目的 Electron 桌面端（GUI），仅保留并独立打包纯 Node.js 的 headless 核心服务；新增一个运维 CLI（更新 OpenCode / 读取免费模型 / 测试免费模型）以及面向本地调用的文档。
- **核心逻辑归属**：`src/` 下的代理核心（协议适配、OpenCode 运行时注入、模型目录读取、工具调用审批网关等）均来自原项目，版权归原作者所有。
- **免责声明**：原项目仓库未附带明确的许可证文件。本衍生仓库仅用于学习与个人本地使用；如原作者对本发布方式有任何异议，请通过 Issue 联系，我会第一时间调整或下架。
- **推荐**：如果你想要桌面图形界面、托盘常驻、一键导入 WorkBuddy 等完整体验，请直接使用原版 [OW Bridge](https://github.com/louchi1984-coder/ow-bridge)。

---

## 1. 环境要求

- **Node.js >= 22**（本机已验证 v22.22.2 可用）
- 首次启动需联网（自动下载 OpenCode 运行时到数据目录，约数十 MB）

## 2. 快速开始

```bash
npm install        # 只装 tar + undici
npm start          # 或 Windows 双击 start.bat / macOS·Linux 运行 ./start.sh
```

启动后控制台会打印：

```
OW Bridge ready at http://127.0.0.1:41980/v1; 9 free models
```

服务**只绑定 127.0.0.1**（本机回环），不会对外暴露。

## 3. 获取 API Key（Bearer Token）

首次启动会在数据目录自动生成一个随机 token，文件路径：

| 系统 | 路径 |
|------|------|
| Windows | `%APPDATA%\Buddy Bridge\api-key` |
| macOS   | `~/Library/Application Support/Buddy Bridge/api-key` |
| Linux   | `~/.config/Buddy Bridge/api-key` |

查看：

```bash
# Windows (PowerShell / CMD)
type "%APPDATA%\Buddy Bridge\api-key"

# macOS / Linux
cat "$HOME/.config/Buddy Bridge/api-key"
```

后续所有请求都带 `Authorization: Bearer <token>`。

> 可用环境变量 `BUDDY_DATA_DIR` 自定义数据目录（token 会生成在该目录下的 `api-key`）。

## 4. API 信息（本地调用）

**Base URL：** `http://127.0.0.1:41980/v1`
**鉴权：** `Authorization: Bearer <token>`

### 4.1 列出可用模型

```bash
curl http://127.0.0.1:41980/v1/models \
  -H "Authorization: Bearer <token>"
```

返回 9 个免费模型，ID 形如 `OC · <名称>`：

| 模型 ID |
|---------|
| `OC · Beam Free` |
| `OC · Big Pickle` |
| `OC · DeepSeek V4.1 Flash Free` |
| `OC · Flint 40B Free` |
| `OC · GLM-5.3-Flash Free` |
| `OC · MiMo-V2.6-Flash Free` |
| `OC · Nemotron 3 Ultra Free` |
| `OC · Nemotron 3.5 Lightning Free` |
| `OC · Nemotron 3.5 Super VL Free` |

### 4.2 对话（OpenAI 兼容格式）

```bash
curl -X POST http://127.0.0.1:41980/v1/chat/completions \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "OC · Big Pickle",
    "messages": [
      {"role": "user", "content": "用一句话解释什么是 API。"}
    ],
    "stream": false
  }'
```

支持多轮、`tools` 函数调用（工具调用经 `buddy-bridge` agent 审批网关）、流式 `stream: true`。

> **关于 `reasoning_effort`：** 代理层对推理档位完全容错——客户端传任意 `reasoning_effort`（含 `none`/`minimal`/`medium` 等）都不会报错，模型走默认行为。若某个档位映射到该模型的合法 variant 则会生效，否则静默忽略。

### 4.3 健康检查

```bash
curl http://127.0.0.1:41980/health \
  -H "Authorization: Bearer <token>"
```

返回服务状态与模型数量。

## 5. 与 Hermes 对接示例

在 Hermes 的 `config.yaml` 中注册为自定义 provider（同机回环地址自动信任）：

```yaml
model:
  default: "OC · Big Pickle"
  provider: owbridge
providers:
  owbridge:
    name: "OW Bridge"
    api: "http://127.0.0.1:41980/v1"
    api_key: "<上面拿到的 token>"
    default_model: "OC · Big Pickle"
    models:
      - "OC · Beam Free"
      - "OC · Big Pickle"
      - "OC · DeepSeek V4.1 Flash Free"
      - "OC · Flint 40B Free"
      - "OC · GLM-5.3-Flash Free"
      - "OC · MiMo-V2.6-Flash Free"
      - "OC · Nemotron 3 Ultra Free"
      - "OC · Nemotron 3.5 Lightning Free"
      - "OC · Nemotron 3.5 Super VL Free"
```

改完执行 `systemctl --user restart hermes-gateway`（或在网页控制台重开会话）。

## 6. 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `BUDDY_PORT` | `41980` | 监听端口（仅 127.0.0.1） |
| `BUDDY_DATA_DIR` | 见第 3 节 | 数据目录（token、OpenCode 运行时、状态） |
| `BUDDY_NO_SYNC` | 未设置 | 设为 `1` 时不同步到 WorkBuddy 的 models.json（本地 API 调用建议开启） |

## 7. 运维命令（CLI）

除了启动 HTTP 服务，headless 版还内置一个运维 CLI（`src/cli.mjs`），直接驱动 OpenCode 运行时，**不经过 HTTP 服务、也不需要 api-key**，适合在本地做更新与自检。

```bash
node src/cli.mjs <命令>
# 或用 npm 脚本：npm run update | npm run models | npm run test:models
```

| 命令 | 作用 |
|------|------|
| `update` | 更新 OpenCode 运行时（已是最新版本则跳过下载） |
| `models` | 读取并列出当前可用的免费模型 |
| `test`   | 逐个测试免费模型的对话能力（含耗时、通过/失败与失败原因） |

说明：
- 首次运行会自动下载 OpenCode 运行时（约数十 MB），请保持联网。
- `test` 会对每个模型发一条最小对话请求；遇到「地区不可用 / 模型不可用 / 超时」等上游情况会如实标记为 FAIL 并打印原因，不影响其余模型。
- 可用 `BUDDY_DATA_DIR` 指定数据目录（默认见第 3 节）；CLI 与 HTTP 服务共用同一目录，OpenCode 运行时只需下载一次。
- 验证示例（本机实测）：`update` → OpenCode 1.19.4 就绪；`models` → 列出 9 个免费模型；`test` → 6 通过 / 3 失败（失败项为上游地区/可用性限制，非工具问题）。

## 8. 目录结构

```
ow-bridge-headless/
├── src/            # headless 服务（21 个模块）+ 运维 CLI（cli.mjs）
├── package.json    # 仅 tar + undici 依赖
├── start.sh        # macOS / Linux 启动
├── start.bat       # Windows 启动
└── README.md       # 本文档
```

`buddy-bridge` 审批网关 agent 由服务在启动时通过环境变量注入，**无需任何额外配置文件**。
