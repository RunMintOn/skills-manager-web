# Skill Vault Manager

WSL 内运行、Windows 浏览器访问的 localhost Skill 和通用链接管理器。Node 服务默认监听 `127.0.0.1:8787`。Vault 始终只读；链接创建和删除在用户明确确认后由软件真实执行。

## 开发与运行

```bash
npm install
npm run typecheck
npm test
npm run build

# 开发 UI（Vite 127.0.0.1:5173；需要同时启动 API）
npm run server
npm run dev
# 浏览器打开 http://127.0.0.1:5173

# 生产首帧：自动构建并启动 Node 服务
npm start
# 浏览器打开 http://127.0.0.1:8787
```

`npm start` 会先构建前端，再启动服务。服务已运行时，重复执行会复用现有服务，不会因 8787 端口重复占用而报错。`start.bat` / `start.vbs` 也使用同一流程。测试时可以用 `SKILLS_MANAGER_PORT=8788` 临时改端口（默认产品端口仍是 8787）。

## 配置

应用配置唯一默认位置是项目内 `data/config.json`，该文件已加入 `.gitignore`。首次访问在该文件不存在时只读使用项目 `fixtures/` 作为演示数据，不会写入文件，也不会隐式读取用户 home。UI 的“配置”保存只写配置 JSON，不创建、删除或修改 Vault/Agent 路径。

配置格式：

```json
{
  "schemaVersion": 1,
  "vault": { "path": "/absolute/read-only/vault", "host": "wsl" },
  "agents": [
    { "id": "pi", "name": "Pi", "host": "wsl", "path": "/absolute/agent/skills" }
  ],
  "commonPaths": [
    { "id": "vault", "name": "Vault", "host": "wsl", "path": "/absolute/read-only/vault" }
  ],
  "selectedAgentId": "pi"
}
```

`host` 必须显式为 `wsl` 或 `windows`。相对路径只在显式配置文件所在目录解析；API 服务可通过 `SKILLS_MANAGER_CONFIG=/explicit/file.json` 选择配置文件，不使用 home 配置。

## HTTP API

服务提供稳定 JSON（顶层 `schemaVersion: 1`）：

- `GET /api/init`：服务、配置摘要、Vault 摘要、Agent 问题计数。
- `GET /api/vault`：递归 Vault 扫描、frontmatter、Collection/Loose 分组和校验。
- `GET /api/config` / `PUT /api/config`：读写应用配置。
- `GET /api/agent/:id`：指定 Agent 实际条目和比较结果。
- `POST /api/plan`：请求体 `{ "agentId": "...", "selectedSkillIds": ["..."] }`，只返回预览计划。
- `POST /api/sync`：请求体增加 `confirm: true`，按预览计划真实创建缺失的 Skill 链接，返回每项结果和刷新后的 Agent 状态。
- `POST /api/links/preflight`：检查任意目标路径和链接路径。
- `POST /api/links/create`：预检通过后创建真实链接。
- `POST /api/links/delete`：只删除已识别的链接入口，不删除目标内容。
- `POST /api/links/scan`：扫描目录，支持不跟随链接的递归模式。

通用链接支持 WSL 符号链接、WSL 与 Windows 驱动器路径之间的链接，以及 Windows Junction/符号链接。计划中的 WSL 操作仍使用 argv 数组（`shell: false`）；Windows 操作使用 typed filesystem 参数或编码后的 PowerShell 调用，不拼接可执行 shell 命令。

## CLI

CLI 与 API 共用 `src/core`，显式配置路径示例：

```bash
node src/server/cli.ts config init --config /tmp/skills-manager-fixture.json
node src/server/cli.ts status --json --config /tmp/skills-manager-fixture.json
node src/server/cli.ts plan --json --config /tmp/skills-manager-fixture.json \
  --agent fixture-agent --skills code-review,unicode-helper
```

`config init` 只创建传入的配置文件，默认内容指向项目 fixtures；不会创建任何链接。`status` 扫描只读，`plan` 每个 Skill 一项且始终 `not-run`。

## Windows 开始菜单入口

1. 保持项目在 WSL 原生路径 `/home/lee/11MyProjrct/44-skills-manager-web`，并确保 WSL 中已 `npm install`、已 `npm run build`。
2. 将 `scripts/start.bat` 或 `scripts/start.vbs` 作为快捷方式目标（也可以复制到 Windows 可访问目录）。`.vbs` 会隐藏 WSL 控制台，`.bat` 便于排错。
3. 右键快捷方式 →“固定到开始屏幕/开始菜单”。快捷方式目标也可使用 `wscript.exe <path-to-start.vbs>`，起始位置不影响 WSL 项目路径。
4. 首次启动后用浏览器访问 `http://localhost:8787`；WSL2 localhost 转发是否被本机策略拦截需要手动确认。

## 安全边界与范围

- Vault 是只读源；扫描不会跟随链接目录，不会执行 YAML 或 shell。
- 扫描无条件递归（隐藏目录如 `.agents/` 也扫描，仅跳过 node_modules）；目录名与 frontmatter `name` 不一致为警告、不阻塞同步；frontmatter 缺失/损坏、重复 Skill ID 才判无效并阻止同步。
- 创建链接前会检查目标存在、链接路径不存在、父目录可用，并拒绝覆盖普通文件或目录。
- 删除链接只接受已识别的符号链接或 Junction，使用不跟随目标的删除操作。
- Skill 同步只创建缺失的扁平链接，不复制 Vault 内容，不覆盖冲突 Agent 条目。
- 创建和删除必须由页面按钮和确认操作触发；扫描、状态和预览不会修改文件系统。

## 验证记录

### 已验证（本工作树）

- `npm run typecheck` 通过。
- `npm test`（Vitest，fixtures + 系统临时目录）通过：Vault 嵌套 Collection、Loose、重复/无效、Agent 六类、比较、预览计划和真实通用链接创建/扫描/删除。
- `npm run build` 通过。
- `node src/server/cli.ts` 直接运行通过；`config init/status --json/plan --json` 已用 fixtures 配置生成 `artifacts/` 输出。
- Node API 的 `/api/init`、`/api/vault`、`/api/config`（含 PUT）、`/api/agent/:id`、`/api/plan`、`/api/links/*`、`/api/sync` 已在临时目录或 fixtures 上验证。默认产品端口为 8787。
- Vite dev 首帧可通过 `curl http://127.0.0.1:5173/` 获取；生产构建由 Node 服务提供静态页面。

### 尚未验证（需用户手动）

- Windows 原生浏览器经 WSL2 localhost 转发访问的实际网络链路。
- Windows Host Junction 在当前目标机器上的实际权限和系统策略；WSL 临时目录上的真实符号链接已验证。
- 不同窗口尺寸下的最终视觉手感。
