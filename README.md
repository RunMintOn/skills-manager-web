# Skill Vault Manager

WSL 内运行、Windows 浏览器访问的 localhost Skill 管理器。Node 服务默认监听 `127.0.0.1:8787`；Vault 和 Agent 扫描只读，同步只生成 `execution=not-run` 预览。

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

# 生产首帧：先 build，再启动 Node 服务
npm run build
npm start
# 浏览器打开 http://127.0.0.1:8787
```

`start.bat` / `start.vbs` 是 Windows 入口素材：它们通过 `wsl.exe` 在 WSL 原生项目目录启动 Node 服务，并打开 `http://localhost:8787/`。若本机已有服务占用端口，请先关闭旧服务；测试时可以用 `SKILLS_MANAGER_PORT=8788` 临时改端口（默认产品端口仍是 8787）。

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

服务没有真实同步执行端点。计划中的 WSL 操作是 argv 数组（`shell: false`），Windows 操作是 typed `fs.promises.symlink` 参数；不生成 shell command string。

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
- 目录名必须与 frontmatter `name` 精确匹配；重复 Skill ID、无效元数据和六类 Agent 条目都会保留并标风险。
- 扁平 Link Path 只在预览中计算；本阶段不创建/删除/替换任何真实链接或目录。
- 通用链接导航保留为 Phase 2 占位；真实同步执行是后置切片，需单独确认。

## 验证记录

### 已验证（本工作树）

- `npm run typecheck` 通过。
- `npm test`（Vitest，fixtures + 系统临时目录）通过：Vault 嵌套 Collection、Loose、重复/无效、Agent 六类、比较和无写入计划。
- `npm run build` 通过。
- `node src/server/cli.ts` 直接运行通过；`config init/status --json/plan --json` 已用 fixtures 配置生成 `artifacts/` 输出。
- Node API 的 `/api/init`、`/api/vault`、`/api/config`（含 PUT）、`/api/agent/:id`、`/api/plan` 已用 curl 验证稳定 JSON。当前执行环境已有端口捕获进程，因此联调验证使用了临时 `SKILLS_MANAGER_PORT=8788`；默认实现仍为 8787。
- Vite dev 首帧可通过 `curl http://127.0.0.1:5173/` 获取；生产构建由 Node 服务提供静态页面。

### 尚未验证（需用户手动）

- Windows 原生浏览器经 WSL2 localhost 转发访问的实际网络链路。
- 真实浏览器中的三列视觉细节、鼠标滚轮、Tab/Shift+Tab 焦点循环和不同窗口尺寸手感；代码已提供原生 Tab、列表 ↑↓、Space、Enter、`/` 搜索、Esc 关闭路径。
- Windows Host Junction 的实际操作；本阶段没有执行端点，避免误触真实路径。
