import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import nodePath from "node:path"
import { fileURLToPath } from "node:url"
import {
  buildComparison,
  buildPlanForAgent,
  configForWrite,
  DEFAULT_CONFIG_PATH,
  executeDeleteLink,
  executeLink,
  preflightDeleteLink,
  preflightLink,
  readConfigOrFixture,
  scanAgent,
  scanLinkDirectory,
  scanVault,
  scanWorkspace,
  writeConfig,
  type AgentConfig,
  type HostKind,
  type LinkSpec,
  type LoadedConfig,
  type SkillManagerConfig,
  type SyncPlan,
  type SyncPlanOperation,
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
  skillId: string
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
  response.setHeader("Access-Control-Allow-Origin", "*")
  response.setHeader("Access-Control-Allow-Headers", "Content-Type")
  response.setHeader("Access-Control-Allow-Methods", "GET,PUT,POST,OPTIONS")
  response.end(JSON.stringify(value))
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
  if (value !== "wsl" && value !== "windows") throw new Error(`${label} must be wsl or windows`)
  return value
}

function linkSpecBody(value: unknown): LinkSpec {
  const body = objectBody(value)
  const source = body.spec && typeof body.spec === "object" && !Array.isArray(body.spec) ? body.spec as Record<string, unknown> : body
  if (typeof source.targetPath !== "string" || typeof source.linkPath !== "string") throw new Error("targetPath and linkPath are required")
  return {
    targetHost: hostValue(source.targetHost, "targetHost"),
    targetPath: source.targetPath,
    linkHost: hostValue(source.linkHost, "linkHost"),
    linkPath: source.linkPath,
  }
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
    service: { host: HOST, port: PORT, execution: "enabled" },
    config: publicConfig(loaded),
    vault: { path: loaded.vault.path, host: loaded.vault.host, summary: snapshot.vault.summary },
    agents: loaded.agents.map(function (agent): AgentConfig & { issueCount: number } {
      return { ...agent, issueCount: snapshot.agents.find(function (item): boolean { return item.id === agent.id })?.summary.issueCount ?? 0 }
    }),
    selectedAgentId: selectedAgentId(loaded),
    safety: { vault: "read-only", sync: "enabled", filesystemWrites: "enabled" },
  })
}

async function handleConfig(request: IncomingMessage, response: ServerResponse, method: string): Promise<void> {
  if (method === "GET") {
    sendJson(response, 200, publicConfig(await loadConfig()))
    return
  }
  const body = await readBody(request)
  const candidate = body && typeof body === "object" && "config" in body ? (body as { config: unknown }).config : body
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

async function handleLinkDelete(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = objectBody(await readBody(request))
  const host = hostValue(body.host, "host")
  if (typeof body.path !== "string") throw new Error("path is required")
  const input = { host, path: body.path }
  const preflight = await preflightDeleteLink(input)
  const result = preflight.ready ? await executeDeleteLink(input) : undefined
  sendJson(response, 200, { schemaVersion: JSON_SCHEMA, preflight, ...(result ? { result } : {}) })
}

async function handleLinkScan(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = objectBody(await readBody(request))
  const host = hostValue(body.host, "host")
  if (typeof body.path !== "string") throw new Error("path is required")
  const scan = await scanLinkDirectory({ host, path: body.path, recursive: body.recursive === true })
  sendJson(response, 200, { schemaVersion: JSON_SCHEMA, scan })
}

async function executeSyncOperation(operation: SyncPlanOperation, loaded: LoadedConfig, agentConfig: AgentConfig): Promise<SyncResult> {
  if (operation.action === "create-link" && operation.targetPath && operation.linkPath) {
    const result = await executeLink({ targetHost: loaded.vault.host, targetPath: operation.targetPath, linkHost: agentConfig.host, linkPath: operation.linkPath })
    return { id: operation.id, skillId: operation.skillId, action: operation.action, success: result.success, attempted: result.attempted, message: result.message, ...(result.error ? { error: result.error } : {}) }
  }
  if (operation.action === "already-linked") {
    return { id: operation.id, skillId: operation.skillId, action: operation.action, success: true, attempted: false, message: "已存在，无需创建" }
  }
  return { id: operation.id, skillId: operation.skillId, action: operation.action, success: false, attempted: false, message: "已阻止", ...(operation.risks.length ? { error: operation.risks.join("；") } : {}) }
}

function executionState(operation: SyncPlanOperation, result: SyncResult | undefined): SyncPlanOperation["execution"] {
  if (operation.action === "already-linked") return "skipped"
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
  const fallback = snapshot.vault.skills.filter(function (skill): boolean { return skill.validity === "valid" }).map(function (skill): string { return skill.id })
  const plan = buildPlanForAgent({ config: loaded, vault: snapshot.vault, agent, selectedSkillIds: selectedSkillIds(body, fallback) })
  const results: SyncResult[] = []
  for (const operation of plan.operations) results.push(await executeSyncOperation(operation, loaded, agentConfig))
  const refreshedAgent = await scanAgent(agentConfig, snapshot.vault)
  const refreshedComparison = buildComparison(snapshot.vault, refreshedAgent)
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
  if (!agent) {
    sendJson(response, 404, errorJson("agent not found", "not-found"))
    return
  }
  const fallback = snapshot.vault.skills.filter(function (skill): boolean { return skill.validity === "valid" }).map(function (skill): string { return skill.id })
  const plan = buildPlanForAgent({ config: loaded, vault: snapshot.vault, agent, selectedSkillIds: selectedSkillIds(body, fallback) })
  sendJson(response, 200, { schemaVersion: JSON_SCHEMA, plan, execution: "not-run" })
}

async function handleApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  const method = request.method ?? "GET"
  if (method === "OPTIONS") {
    sendJson(response, 204, {})
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
    if (url.pathname === "/api/links/delete" && method === "POST") return await handleLinkDelete(request, response)
    if (url.pathname === "/api/links/scan" && method === "POST") return await handleLinkScan(request, response)
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
    createReadStream(candidate).pipe(response)
  } catch {
    if (requested !== "/index.html") {
      try {
        const fallback = await stat(nodePath.join(distRoot, "index.html"))
        if (fallback.isFile()) {
          response.statusCode = 200
          response.setHeader("Content-Type", "text/html; charset=utf-8")
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
