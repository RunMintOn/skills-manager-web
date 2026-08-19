import { createReadStream } from "node:fs"
import { access, constants, stat } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import nodePath from "node:path"
import { fileURLToPath } from "node:url"
import {
  buildPlanForAgent,
  buildStatusSnapshot,
  configForWrite,
  DEFAULT_CONFIG_PATH,
  readConfigOrFixture,
  scanAgent,
  scanVault,
  scanWorkspace,
  writeConfig,
  type LoadedConfig,
  type SkillManagerConfig,
} from "../core/index.ts"

const HOST = "127.0.0.1"
const PORT = Number(process.env.SKILLS_MANAGER_PORT ?? "8787")
const projectRoot = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "../..")
const distRoot = nodePath.join(projectRoot, "dist")
const configPath = process.env.SKILLS_MANAGER_CONFIG ? nodePath.resolve(process.env.SKILLS_MANAGER_CONFIG) : DEFAULT_CONFIG_PATH
const JSON_SCHEMA = 1

type JsonValue = Record<string, unknown> | unknown[]
function sendJson(response: ServerResponse, status: number, value: JsonValue): void {
  const payload = JSON.stringify(value)
  response.statusCode = status
  response.setHeader("Content-Type", "application/json; charset=utf-8")
  response.setHeader("Cache-Control", "no-store")
  response.setHeader("Access-Control-Allow-Origin", "*")
  response.setHeader("Access-Control-Allow-Headers", "Content-Type")
  response.setHeader("Access-Control-Allow-Methods", "GET,PUT,POST,OPTIONS")
  response.end(payload)
}
function errorJson(message: string, code = "request-error"): Record<string, unknown> { return { schemaVersion: JSON_SCHEMA, error: { code, message } } }
async function readBody(request: IncomingMessage): Promise<unknown> {
  let body = ""
  for await (const chunk of request) { body += String(chunk); if (body.length > 1_000_000) throw new Error("request body is too large") }
  if (!body.trim()) return {}
  try { return JSON.parse(body) as unknown } catch { throw new Error("request body must be valid JSON") }
}
async function config(): Promise<LoadedConfig> { return readConfigOrFixture(configPath) }
function publicConfig(loaded: LoadedConfig): Record<string, unknown> { return { schemaVersion: JSON_SCHEMA, configPath: loaded.configPath, exists: loaded.exists, config: configForWrite(loaded) } }
function selectedAgentId(loaded: LoadedConfig, requested?: string): string | undefined { return requested ?? loaded.selectedAgentId ?? loaded.agents[0]?.id }
async function handleApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  const method = request.method ?? "GET"
  if (method === "OPTIONS") { sendJson(response, 204, {}); return }
  try {
    if (url.pathname === "/api/init" && method === "GET") {
      const loaded = await config(); const snapshot = await scanWorkspace(loaded)
      sendJson(response, 200, { schemaVersion: JSON_SCHEMA, service: { host: HOST, port: PORT, execution: "preview-only" }, config: publicConfig(loaded), vault: { path: loaded.vault.path, host: loaded.vault.host, summary: snapshot.vault.summary }, agents: loaded.agents.map((agent) => ({ ...agent, issueCount: snapshot.agents.find((item) => item.id === agent.id)?.summary.issueCount ?? 0 })), selectedAgentId: selectedAgentId(loaded), safety: { vault: "read-only", sync: "preview-only", filesystemWrites: "disabled" } })
      return
    }
    if (url.pathname === "/api/vault" && method === "GET") { const loaded = await config(); sendJson(response, 200, { schemaVersion: JSON_SCHEMA, vault: await scanVault(loaded.vault), execution: "read-only" }); return }
    if (url.pathname === "/api/config" && method === "GET") { sendJson(response, 200, publicConfig(await config())); return }
    if (url.pathname === "/api/config" && method === "PUT") {
      const body = await readBody(request); const candidate = (body && typeof body === "object" && "config" in body ? (body as { config: unknown }).config : body) as SkillManagerConfig
      const saved = await writeConfig(configPath, candidate); sendJson(response, 200, publicConfig(saved)); return
    }
    const agentMatch = url.pathname.match(/^\/api\/agent\/([^/]+)$/u)
    if (agentMatch && method === "GET") {
      const loaded = await config(); const agentConfig = loaded.agents.find((agent) => agent.id === decodeURIComponent(agentMatch[1]!)); if (!agentConfig) { sendJson(response, 404, errorJson("agent not found", "not-found")); return }
      const vault = await scanVault(loaded.vault); const agent = await scanAgent(agentConfig, vault); const comparison = (await import("../core/compare.ts")).buildComparison(vault, agent); sendJson(response, 200, { schemaVersion: JSON_SCHEMA, agent, comparison, execution: "read-only" }); return
    }
    if (url.pathname === "/api/plan" && method === "POST") {
      const body = await readBody(request); const input = body && typeof body === "object" ? body as { agentId?: unknown; selectedSkillIds?: unknown } : {}; const loaded = await config(); const snapshot = await scanWorkspace(loaded); const agentId = typeof input.agentId === "string" ? input.agentId : selectedAgentId(loaded); const agent = snapshot.agents.find((item) => item.id === agentId); if (!agent) { sendJson(response, 404, errorJson("agent not found", "not-found")); return }
      const selected = Array.isArray(input.selectedSkillIds) ? input.selectedSkillIds.filter((item): item is string => typeof item === "string") : snapshot.vault.skills.filter((skill) => skill.validity === "valid").map((skill) => skill.id)
      sendJson(response, 200, { schemaVersion: JSON_SCHEMA, plan: buildPlanForAgent({ config: loaded, vault: snapshot.vault, agent, selectedSkillIds: selected }), execution: "not-run" }); return
    }
    sendJson(response, 404, errorJson("API route not found", "not-found"))
  } catch (error) { sendJson(response, 400, errorJson(error instanceof Error ? error.message : String(error))) }
}
function contentType(path: string): string { return path.endsWith(".html") ? "text/html; charset=utf-8" : path.endsWith(".js") ? "text/javascript; charset=utf-8" : path.endsWith(".css") ? "text/css; charset=utf-8" : path.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream" }
async function serveStatic(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)
  const candidate = nodePath.resolve(distRoot, `.${requested}`)
  if (candidate !== distRoot && !candidate.startsWith(`${distRoot}${nodePath.sep}`)) { sendJson(response, 400, errorJson("unsafe static path", "unsafe-path")); return }
  try { const info = await stat(candidate); if (!info.isFile()) throw new Error("not file"); response.statusCode = 200; response.setHeader("Content-Type", contentType(candidate)); createReadStream(candidate).pipe(response) } catch { if (requested !== "/index.html") { try { const fallback = await stat(nodePath.join(distRoot, "index.html")); if (fallback.isFile()) { response.statusCode = 200; response.setHeader("Content-Type", "text/html; charset=utf-8"); createReadStream(nodePath.join(distRoot, "index.html")).pipe(response); return } } catch { /* no production build yet */ } } sendJson(response, 404, errorJson("UI build not found; run npm run build", "ui-not-built")) }
}
export const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`)
  if (url.pathname.startsWith("/api/")) await handleApi(request, response, url)
  else if (request.method === "GET" || request.method === "HEAD") await serveStatic(request, response, url)
  else sendJson(response, 405, errorJson("method not allowed", "method-not-allowed"))
})
if (process.argv[1] && nodePath.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, HOST, () => console.log(`Skill Vault Manager listening on http://${HOST}:${PORT}`))
}
