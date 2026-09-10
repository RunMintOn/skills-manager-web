import { createReadStream } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import nodePath from "node:path"
import { fileURLToPath } from "node:url"
import {
  appendSafeChild,
  buildComparison,
  preflightBatchLinks,
  buildPlanForAgent,
  configForWrite,
  convertCopyToLink,
  DEFAULT_CONFIG_PATH,
  executeDeleteLink,
  executeLink,
  executeMirrorSync,
  findVaultSkillById,
  getHostPathAdapter,
  parseFrontmatter,
  planMirrorSync,
  preflightDeleteLink,
  preflightLink,
  readConfigOrFixture,
  runtimeHost,
  scanAgent,
  scanLinkDirectory,
  scanVault,
  scanWorkspace,
  windowsPathToWsl,
  writeConfig,
  type AgentConfig,
  type BatchLinkExecution,
  type HostKind,
  type LinkRecord,
  type LinkSpec,
  type LoadedConfig,
  type MirrorSyncConfig,
  type SkillManagerConfig,
  type SyncPlan,
  type SyncPlanOperation,
  type VaultConfig,
} from "../core/index.ts"

const HOST = "127.0.0.1"
const PORT = Number(process.env.SKILLS_MANAGER_PORT ?? "8787")
const projectRoot = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "../..")
const distRoot = nodePath.join(projectRoot, "dist")
const configPath = process.env.SKILLS_MANAGER_CONFIG ? nodePath.resolve(process.env.SKILLS_MANAGER_CONFIG) : DEFAULT_CONFIG_PATH
const JSON_SCHEMA = 1

type JsonValue = Record<string, unknown> | unknown[]
type SyncResult = {
  id: string
  skillKey: string
  action: string
  success: boolean
  attempted: boolean
  message: string
  error?: string
}

function sendJson(response: ServerResponse, status: number, value: JsonValue): void {
  response.statusCode = status
  response.setHeader("Content-Type", "application/json; charset=utf-8")
  response.setHeader("Cache-Control", "no-store")
  response.end(JSON.stringify(value))
}

// 只服务本机浏览器。校验 Host 头，拒绝 DNS rebinding 把 API 映射成攻击者域名。
function trustedHost(header: string | undefined): boolean {
  if (!header) return false
  const hostname = header.toLowerCase().split(":")[0]!
  return hostname === "127.0.0.1" || hostname === "localhost"
}

function errorJson(message: string, code = "request-error"): Record<string, unknown> {
  return { schemaVersion: JSON_SCHEMA, error: { code, message } }
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  let body = ""
  for await (const chunk of request) {
    body += String(chunk)
    if (body.length > 1_000_000) throw new Error("request body is too large")
  }
  if (!body.trim()) return {}
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new Error("request body must be valid JSON")
  }
}

async function loadConfig(): Promise<LoadedConfig> {
  return readConfigOrFixture(configPath)
}

function publicConfig(loaded: LoadedConfig): Record<string, unknown> {
  return { schemaVersion: JSON_SCHEMA, configPath: loaded.configPath, exists: loaded.exists, config: configForWrite(loaded) }
}

function selectedAgentId(loaded: LoadedConfig, requested?: string): string | undefined {
  return requested ?? loaded.selectedAgentId ?? loaded.agents[0]?.id
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request body must be an object")
  return value as Record<string, unknown>
}

function optionalObjectBody(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function hostValue(value: unknown, label: string): HostKind {
  if (value !== "wsl" && value !== "windows" && value !== "macos") throw new Error(`${label} must be wsl, windows or macos`)
  return value
}

function assertHostAvailable(host: HostKind): void {
  if (runtimeHost() === "macos" && host !== "macos") throw new Error("macOS 工作区只支持 macos Host")
}

function assertRuntimeConfig(config: SkillManagerConfig): void {
  if (runtimeHost() !== "macos") return
  const hosts = [config.vault.host, ...config.agents.map(function (agent): HostKind { return agent.host }), ...(config.commonPaths ?? []).map(function (item): HostKind { return item.host })]
  if (hosts.some(function (host): boolean { return host !== "macos" }) || config.mirrorSync) throw new Error("macOS 工作区只接受本地 macos 配置")
}

function linkSpecBody(value: unknown): LinkSpec {
  const body = objectBody(value)
  const source = body.spec && typeof body.spec === "object" && !Array.isArray(body.spec) ? body.spec as Record<string, unknown> : body
  if (typeof source.targetPath !== "string" || typeof source.linkPath !== "string") throw new Error("targetPath and linkPath are required")
  const spec = {
    targetHost: hostValue(source.targetHost, "targetHost"),
    targetPath: source.targetPath,
    linkHost: hostValue(source.linkHost, "linkHost"),
    linkPath: source.linkPath,
  }
  assertHostAvailable(spec.targetHost)
  assertHostAvailable(spec.linkHost)
  return spec
}

function selectedSkillIds(body: Record<string, unknown>, fallback: string[]): string[] {
  if (!Array.isArray(body.selectedSkillIds)) return fallback
  return body.selectedSkillIds.filter(function (item): item is string { return typeof item === "string" })
}

async function handleInit(response: ServerResponse): Promise<void> {
  const loaded = await loadConfig()
  const snapshot = await scanWorkspace(loaded)
  sendJson(response, 200, {
    schemaVersion: JSON_SCHEMA,
    runtimeHost: runtimeHost(),
    service: { host: HOST, port: PORT, execution: "enabled" },
    config: publicConfig(loaded),
    vault: { path: loaded.vault.path, host: loaded.vault.host, summary: snapshot.vault.summary },
    agents: loaded.agents.map(function (agent): AgentConfig & { issueCount: number } {
      return { ...agent, issueCount: snapshot.agents.find(function (item): boolean { return item.id === agent.id })?.summary.issueCount ?? 0 }
    }),
    selectedAgentId: selectedAgentId(loaded),
    safety: { vault: "read-only", sync: runtimeHost() === "macos" ? "disabled" : "enabled", filesystemWrites: "enabled" },
  })
}

async function handleConfig(request: IncomingMessage, response: ServerResponse, method: string): Promise<void> {
  if (method === "GET") {
    sendJson(response, 200, publicConfig(await loadConfig()))
    return
  }
  const body = await readBody(request)
  const candidate = body && typeof body === "object" && "config" in body ? (body as { config: unknown }).config : body
  assertRuntimeConfig(candidate as SkillManagerConfig)
  const saved = await writeConfig(configPath, candidate as SkillManagerConfig)
  sendJson(response, 200, publicConfig(saved))
}

async function handleAgent(response: ServerResponse, id: string): Promise<void> {
  const loaded = await loadConfig()
  const agentConfig = loaded.agents.find(function (agent): boolean { return agent.id === id })
  if (!agentConfig) {
    sendJson(response, 404, errorJson("agent not found", "not-found"))
    return
  }
  const vault = await scanVault(loaded.vault)
  const agent = await scanAgent(agentConfig, vault)
  sendJson(response, 200, { schemaVersion: JSON_SCHEMA, agent, comparison: buildComparison(vault, agent), execution: "read-only" })
}

async function handleLinkPreflight(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const spec = linkSpecBody(await readBody(request))
  sendJson(response, 200, { schemaVersion: JSON_SCHEMA, preflight: await preflightLink(spec) })
}

async function handleLinkCreate(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const spec = linkSpecBody(await readBody(request))
  const preflight = await preflightLink(spec)
  const result = preflight.ready
    ? await executeLink(spec)
    : { schemaVersion: JSON_SCHEMA, attempted: false, success: false, spec: preflight.spec, message: "链接未创建", error: preflight.risks.join("；") || "预检未通过" }
  sendJson(response, 200, { schemaVersion: JSON_SCHEMA, preflight, result })
}

async function handleBatchLinkPreflight(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const spec = linkSpecBody(await readBody(request))
  sendJson(response, 200, { schemaVersion: JSON_SCHEMA, preflight: await preflightBatchLinks(spec) })
}

async function handleBatchLinkCreate(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = objectBody(await readBody(request))
  if (body.confirm !== true) throw new Error("batch link execution requires confirm=true")
  const spec = linkSpecBody(body)
  const preflight = await preflightBatchLinks(spec)
  const results: BatchLinkExecution["results"] = []
  for (const item of preflight.items) {
    const itemSpec = item.preflight.spec
    if (!item.preflight.ready) {
      results.push({ name: item.name, targetPath: itemSpec.targetPath, linkPath: itemSpec.linkPath, action: "blocked", success: false, attempted: false, message: "已阻止", error: item.preflight.risks.join("；") || "预检未通过" })
      continue
    }
    const result = await executeLink(itemSpec)
    results.push({ name: item.name, targetPath: result.spec.targetPath, linkPath: result.spec.linkPath, action: result.success ? "created" : "failed", success: result.success, attempted: result.attempted, message: result.message, ...(result.error ? { error: result.error } : {}) })
  }
  const execution = results.some(function (item): boolean { return item.attempted && !item.success }) ? "failed" : "completed"
  sendJson(response, 200, { schemaVersion: JSON_SCHEMA, execution, preflight, results })
}

async function handleLinkDelete(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = objectBody(await readBody(request))
  const host = hostValue(body.host, "host")
  assertHostAvailable(host)
  if (typeof body.path !== "string") throw new Error("path is required")
  const input = { host, path: body.path }
  const preflight = await preflightDeleteLink(input)
  const result = preflight.ready ? await executeDeleteLink(input) : undefined
  sendJson(response, 200, { schemaVersion: JSON_SCHEMA, preflight, ...(result ? { result } : {}) })
}

async function handleLinkScan(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = objectBody(await readBody(request))
  const host = hostValue(body.host, "host")
  assertHostAvailable(host)
  if (typeof body.path !== "string") throw new Error("path is required")
  const scan = await scanLinkDirectory({ host, path: body.path, recursive: body.recursive === true })
  sendJson(response, 200, { schemaVersion: JSON_SCHEMA, scan })
}

async function executeSyncOperation(operation: SyncPlanOperation, vault: VaultConfig, agentConfig: AgentConfig): Promise<SyncResult> {
  if (operation.action === "create-link" && operation.targetPath && operation.linkPath) {
    const result = await executeLink({ targetHost: vault.host, targetPath: operation.targetPath, linkHost: agentConfig.host, linkPath: operation.linkPath })
    return { id: operation.id, skillKey: operation.skillKey, action: operation.action, success: result.success, attempted: result.attempted, message: result.message, ...(result.error ? { error: result.error } : {}) }
  }
  if (operation.action === "already-linked") {
    return { id: operation.id, skillKey: operation.skillKey, action: operation.action, success: true, attempted: false, message: "已存在，无需创建" }
  }
  // 冲突项：确认后跳过，不创建、不计失败（真相 skip_conflicts 语义）。
  return { id: operation.id, skillKey: operation.skillKey, action: operation.action, success: true, attempted: false, message: "已跳过（冲突项不创建）" }
}

function executionState(operation: SyncPlanOperation, result: SyncResult | undefined): SyncPlanOperation["execution"] {
  if (operation.action === "already-linked" || operation.action === "blocked") return "skipped"
  return result?.success ? "completed" : "failed"
}

function executionPlan(plan: SyncPlan, results: SyncResult[]): SyncPlan {
  return {
    ...plan,
    mode: "execution",
    operations: plan.operations.map(function (operation): SyncPlanOperation {
      const result = results.find(function (item): boolean { return item.id === operation.id })
      return { ...operation, execution: executionState(operation, result) }
    }),
    safety: {
      ...plan.safety,
      filesystemWrites: "enabled",
      windowsExecution: "automatic",
      note: "This confirmed slice executed the safe operations and refreshed the Agent scan.",
    },
  }
}

async function handleSync(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = objectBody(await readBody(request))
  if (body.confirm !== true) throw new Error("sync execution requires confirm=true")
  const loaded = await loadConfig()
  const snapshot = await scanWorkspace(loaded)
  const agentId = typeof body.agentId === "string" ? body.agentId : selectedAgentId(loaded)
  const agentConfig = loaded.agents.find(function (agent): boolean { return agent.id === agentId })
  const agent = snapshot.agents.find(function (item): boolean { return item.id === agentId })
  if (!agentConfig || !agent) {
    sendJson(response, 404, errorJson("agent not found", "not-found"))
    return
  }
  const vault = await scanVault(loaded.vault)
  const fallback = vault.skills.filter(function (skill): boolean { return skill.validity === "valid" }).map(function (skill): string { return skill.relativePath })
  const plan = buildPlanForAgent({ config: loaded, vault, agent, selectedSkillIds: selectedSkillIds(body, fallback) })
  const results: SyncResult[] = []
  for (const operation of plan.operations) results.push(await executeSyncOperation(operation, vault, agentConfig))
  // 链接记录：创建成功的操作写入来源集合（真相 LinkRecord 语义，flattening 不丢 provenance）。
  const nextLinks = [...(loaded.links ?? [])]
  plan.operations.forEach(function (operation, index): void {
    const result = results[index]
    if (!result?.success || operation.action !== "create-link") return
    const skill = vault.skills.find(function (item): boolean { return item.relativePath === operation.skillKey })
    if (!skill) return
    const record: LinkRecord = { skill: skill.relativePath, collection: skill.collection, agentId: agentConfig.id }
    if (!nextLinks.some(function (item): boolean { return item.agentId === record.agentId && item.skill === record.skill })) nextLinks.push(record)
  })
  if (nextLinks.length !== (loaded.links ?? []).length) {
    await writeConfig(configPath, configForWrite({ ...loaded, links: nextLinks }))
  }
  const refreshedAgent = await scanAgent(agentConfig, vault)
  const refreshedComparison = buildComparison(vault, refreshedAgent)
  sendJson(response, 200, {
    schemaVersion: JSON_SCHEMA,
    execution: results.every(function (item): boolean { return item.success }) ? "completed" : "failed",
    plan: executionPlan(plan, results),
    results,
    agent: refreshedAgent,
    comparison: refreshedComparison,
  })
}

async function handlePlan(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = optionalObjectBody(await readBody(request))
  const loaded = await loadConfig()
  const snapshot = await scanWorkspace(loaded)
  const agentId = typeof body.agentId === "string" ? body.agentId : selectedAgentId(loaded)
  const agent = snapshot.agents.find(function (item): boolean { return item.id === agentId })
  const agentConfig = loaded.agents.find(function (item): boolean { return item.id === agentId })
  if (!agent || !agentConfig) {
    sendJson(response, 404, errorJson("agent not found", "not-found"))
    return
  }
  const vault = await scanVault(loaded.vault)
  const fallback = vault.skills.filter(function (skill): boolean { return skill.validity === "valid" }).map(function (skill): string { return skill.relativePath })
  const plan = buildPlanForAgent({ config: loaded, vault, agent, selectedSkillIds: selectedSkillIds(body, fallback) })
  sendJson(response, 200, { schemaVersion: JSON_SCHEMA, plan, execution: "not-run" })
}

function configuredMirrorSync(loaded: LoadedConfig): MirrorSyncConfig {
  if (runtimeHost() === "macos") throw new Error("macOS 工作区不支持 Vault 镜像")
  if (!loaded.mirrorSync) throw new Error("请先保存源 Vault 与镜像 Vault 路径")
  return loaded.mirrorSync
}

async function handleMirrorSource(response: ServerResponse): Promise<void> {
  const loaded = await loadConfig()
  const sync = configuredMirrorSync(loaded)
  sendJson(response, 200, { schemaVersion: JSON_SCHEMA, vault: await scanVault(sync.source), execution: "read-only" })
}

async function handleMirrorPlan(response: ServerResponse): Promise<void> {
  const loaded = await loadConfig()
  const plan = await planMirrorSync(configuredMirrorSync(loaded))
  sendJson(response, 200, { schemaVersion: JSON_SCHEMA, plan, execution: "not-run" })
}

async function handleMirrorExecute(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = objectBody(await readBody(request))
  if (body.confirm !== true) throw new Error("mirror sync execution requires confirm=true")
  const loaded = await loadConfig()
  const preview = await planMirrorSync(configuredMirrorSync(loaded))
  if (!preview.ready) {
    sendJson(response, 200, { schemaVersion: JSON_SCHEMA, execution: "blocked", plan: preview, results: [] })
    return
  }
  const result = await executeMirrorSync(preview)
  const execution = result.results.every(function (item): boolean { return item.success }) ? "completed" : "failed"
  sendJson(response, 200, { ...result, execution })
}

async function handleAgentLinkConvert(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = objectBody(await readBody(request))
  if (typeof body.agentId !== "string" || typeof body.name !== "string") throw new Error("agentId and name are required")
  const loaded = await loadConfig()
  const agentConfig = loaded.agents.find(function (agent): boolean { return agent.id === body.agentId })
  if (!agentConfig) {
    sendJson(response, 404, errorJson("agent not found", "not-found"))
    return
  }
  if (agentConfig.host !== loaded.vault.host) {
    sendJson(response, 400, errorJson("连接操作暂时只支持同一环境：Baseline 与 Agent 必须使用相同 Host", "cross-host-disabled"))
    return
  }
  const name = body.name.trim()
  const adapter = getHostPathAdapter(agentConfig.host)
  let directory: string
  try {
    directory = appendSafeChild(adapter, adapter.normalize(agentConfig.path), name)
  } catch (error) {
    sendJson(response, 400, errorJson(error instanceof Error ? error.message : String(error), "unsafe-name"))
    return
  }
  const runtimeDirectory = agentConfig.host === "windows" ? windowsPathToWsl(directory) ?? directory : directory
  // 真相守卫：目录名与 SKILL.md 的 name 必须一致，否则不能转换。
  const frontmatter = parseFrontmatter(await readFile(adapter.join(runtimeDirectory, "SKILL.md"), "utf8").catch(function (): string { return "" }))
  if (!frontmatter.name || frontmatter.name !== name) {
    sendJson(response, 400, errorJson(`无效 skill：目录名与 SKILL.md 的 name 不一致，不能转换。`, "invalid-skill"))
    return
  }
  const vault = await scanVault(loaded.vault)
  const skill = findVaultSkillById(vault, name)
  if (!skill) {
    sendJson(response, 400, errorJson(`无法识别 ${name} 的来源，不能转换（它不在 vault 中）。`, "not-in-vault"))
    return
  }
  const result = await convertCopyToLink({ host: agentConfig.host, agentPath: agentConfig.path, name, targetPath: skill.absolutePath })
  let links: LinkRecord[] | undefined
  if (result.success) {
    const nextLinks = [...(loaded.links ?? [])]
    const record: LinkRecord = { skill: name, collection: skill.collection, agentId: agentConfig.id }
    if (!nextLinks.some(function (item): boolean { return item.agentId === record.agentId && item.skill === record.skill })) nextLinks.push(record)
    await writeConfig(configPath, configForWrite({ ...loaded, links: nextLinks }))
    links = nextLinks
  }
  sendJson(response, 200, { schemaVersion: JSON_SCHEMA, result, ...(links ? { links } : {}) })
}

async function handleAgentLinkDelete(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = objectBody(await readBody(request))
  if (typeof body.agentId !== "string" || typeof body.skill !== "string") throw new Error("agentId and skill are required")
  const loaded = await loadConfig()
  const agentConfig = loaded.agents.find(function (agent): boolean { return agent.id === body.agentId })
  if (!agentConfig) {
    sendJson(response, 404, errorJson("agent not found", "not-found"))
    return
  }
  const skill = body.skill.trim()
  const adapter = getHostPathAdapter(agentConfig.host)
  let linkPath: string
  try {
    linkPath = appendSafeChild(adapter, adapter.normalize(agentConfig.path), skill)
  } catch (error) {
    sendJson(response, 400, errorJson(error instanceof Error ? error.message : String(error), "unsafe-name"))
    return
  }
  const input = { host: agentConfig.host, path: linkPath }
  const preflight = await preflightDeleteLink(input)
  // 真相守卫：非断链时，目标必须是有效 skill（目录名与 SKILL.md 的 name 一致），否则拒绝删除。
  if (preflight.ready && preflight.targetStatus === "exists" && preflight.targetPath) {
    const runtimeTarget = agentConfig.host === "windows" ? windowsPathToWsl(preflight.targetPath) ?? preflight.targetPath : preflight.targetPath
    const targetFrontmatter = parseFrontmatter(await readFile(adapter.join(runtimeTarget, "SKILL.md"), "utf8").catch(function (): string { return "" }))
    if (!targetFrontmatter.name || targetFrontmatter.name !== adapter.basename(preflight.targetPath)) {
      sendJson(response, 400, errorJson(`无效 skill，不能删除链接。`, "invalid-skill"))
      return
    }
  }
  const result = preflight.ready ? await executeDeleteLink(input) : undefined
  let links: LinkRecord[] | undefined
  if (result?.success) {
    const nextLinks = (loaded.links ?? []).filter(function (item): boolean { return !(item.agentId === agentConfig.id && item.skill === skill) })
    await writeConfig(configPath, configForWrite({ ...loaded, links: nextLinks }))
    links = nextLinks
  }
  sendJson(response, 200, { schemaVersion: JSON_SCHEMA, preflight, ...(result ? { result } : {}), ...(links ? { links } : {}) })
}

async function handleApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  const method = request.method ?? "GET"
  if (!trustedHost(request.headers.host)) {
    sendJson(response, 403, errorJson("untrusted host header", "untrusted-host"))
    return
  }
  try {
    if (url.pathname === "/api/init" && method === "GET") return await handleInit(response)
    if (url.pathname === "/api/vault" && method === "GET") {
      const loaded = await loadConfig()
      sendJson(response, 200, { schemaVersion: JSON_SCHEMA, vault: await scanVault(loaded.vault), execution: "read-only" })
      return
    }
    if (url.pathname === "/api/config" && (method === "GET" || method === "PUT")) return await handleConfig(request, response, method)
    const agentMatch = url.pathname.match(/^\/api\/agent\/([^/]+)$/u)
    if (agentMatch && method === "GET") return await handleAgent(response, decodeURIComponent(agentMatch[1]!))
    if (url.pathname === "/api/links/preflight" && method === "POST") return await handleLinkPreflight(request, response)
    if (url.pathname === "/api/links/create" && method === "POST") return await handleLinkCreate(request, response)
    if (url.pathname === "/api/links/batch-preflight" && method === "POST") return await handleBatchLinkPreflight(request, response)
    if (url.pathname === "/api/links/batch-create" && method === "POST") return await handleBatchLinkCreate(request, response)
    if (url.pathname === "/api/links/delete" && method === "POST") return await handleLinkDelete(request, response)
    if (url.pathname === "/api/links/scan" && method === "POST") return await handleLinkScan(request, response)
    if (url.pathname === "/api/mirror-sync/source" && method === "GET") return await handleMirrorSource(response)
    if (url.pathname === "/api/mirror-sync/plan" && method === "POST") return await handleMirrorPlan(response)
    if (url.pathname === "/api/mirror-sync/execute" && method === "POST") return await handleMirrorExecute(request, response)
    if (url.pathname === "/api/agent-links/convert" && method === "POST") return await handleAgentLinkConvert(request, response)
    if (url.pathname === "/api/agent-links/delete" && method === "POST") return await handleAgentLinkDelete(request, response)
    if (url.pathname === "/api/sync" && method === "POST") return await handleSync(request, response)
    if (url.pathname === "/api/plan" && method === "POST") return await handlePlan(request, response)
    sendJson(response, 404, errorJson("API route not found", "not-found"))
  } catch (error) {
    sendJson(response, 400, errorJson(error instanceof Error ? error.message : String(error)))
  }
}

function contentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8"
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8"
  if (path.endsWith(".css")) return "text/css; charset=utf-8"
  if (path.endsWith(".svg")) return "image/svg+xml"
  return "application/octet-stream"
}

async function serveStatic(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)
  const candidate = nodePath.resolve(distRoot, `.${requested}`)
  if (candidate !== distRoot && !candidate.startsWith(`${distRoot}${nodePath.sep}`)) {
    sendJson(response, 400, errorJson("unsafe static path", "unsafe-path"))
    return
  }
  try {
    const info = await stat(candidate)
    if (!info.isFile()) throw new Error("not file")
    response.statusCode = 200
    response.setHeader("Content-Type", contentType(candidate))
    response.setHeader("Cache-Control", "no-store")
    createReadStream(candidate).pipe(response)
  } catch {
    if (requested !== "/index.html") {
      try {
        const fallback = await stat(nodePath.join(distRoot, "index.html"))
        if (fallback.isFile()) {
          response.statusCode = 200
          response.setHeader("Content-Type", "text/html; charset=utf-8")
          response.setHeader("Cache-Control", "no-store")
          createReadStream(nodePath.join(distRoot, "index.html")).pipe(response)
          return
        }
      } catch {
        // The production build is not available yet.
      }
    }
    sendJson(response, 404, errorJson("UI build not found; run npm run build", "ui-not-built"))
  }
}

export const server = createServer(async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`)
  if (url.pathname.startsWith("/api/")) {
    await handleApi(request, response, url)
    return
  }
  if (request.method === "GET" || request.method === "HEAD") {
    await serveStatic(request, response, url)
    return
  }
  sendJson(response, 405, errorJson("method not allowed", "method-not-allowed"))
})

if (process.argv[1] && nodePath.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, HOST, function (): void { console.log(`Skill Vault Manager listening on http://${HOST}:${PORT}`) })
}
