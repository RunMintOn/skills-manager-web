import type { AgentConfig, AgentScan, ComparisonResult, HostKind, LinkDeletePreflight, LinkExecutionResult, LinkPreflight, LinkRecord, LinkScan, LinkSpec, SkillManagerConfig, SyncPlan, VaultScan } from "../core/types.ts"

const API_ROOT = "/api"

export interface InitResponse {
  schemaVersion: 1
  service: { host: string; port: number; execution: "enabled" }
  config: { configPath: string; exists: boolean; config: SkillManagerConfig }
  vault: { path: string; host: HostKind; summary: VaultScan["summary"] }
  agents: Array<AgentConfig & { issueCount: number }>
  selectedAgentId?: string
  safety: { vault: string; sync: string; filesystemWrites: string }
}

export interface ConfigResponse { schemaVersion: 1; configPath: string; exists: boolean; config: SkillManagerConfig }
export interface AgentResponse { schemaVersion: 1; agent: AgentScan; comparison: ComparisonResult; execution: "read-only" }
export interface PlanResponse { schemaVersion: 1; plan: SyncPlan; execution: "not-run" }
export interface SyncResponse {
  schemaVersion: 1
  execution: "completed" | "failed"
  plan: SyncPlan
  results: Array<{ id: string; skillKey: string; action: string; success: boolean; attempted: boolean; message: string; error?: string }>
  agent: AgentScan
  comparison: ComparisonResult
}
export interface LinkPreflightResponse { schemaVersion: 1; preflight: LinkPreflight }
export interface LinkCreateResponse { schemaVersion: 1; result: LinkExecutionResult; preflight: LinkPreflight }
export interface LinkDeleteResponse { schemaVersion: 1; preflight: LinkDeletePreflight; result?: LinkExecutionResult }
export interface LinkScanResponse { schemaVersion: 1; scan: LinkScan }
export interface AgentLinkResponse {
  schemaVersion: 1
  result: LinkExecutionResult
  preflight?: LinkDeletePreflight
  links?: LinkRecord[]
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_ROOT}${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } })
  const body = await response.json() as T & { error?: { message?: string } }
  if (!response.ok) throw new Error(body.error?.message ?? `API ${response.status}`)
  return body
}

function init(): Promise<InitResponse> { return request<InitResponse>("/init") }
function vault(): Promise<{ schemaVersion: 1; vault: VaultScan }> { return request<{ schemaVersion: 1; vault: VaultScan }>("/vault") }
function config(): Promise<ConfigResponse> { return request<ConfigResponse>("/config") }
function putConfig(value: SkillManagerConfig): Promise<ConfigResponse> {
  return request<ConfigResponse>("/config", { method: "PUT", body: JSON.stringify(value) })
}
function agent(id: string): Promise<AgentResponse> { return request<AgentResponse>(`/agent/${encodeURIComponent(id)}`) }
function plan(agentId: string, selectedSkillIds: string[]): Promise<PlanResponse> {
  return request<PlanResponse>("/plan", { method: "POST", body: JSON.stringify({ agentId, selectedSkillIds }) })
}
function executeSync(agentId: string, selectedSkillIds: string[]): Promise<SyncResponse> {
  return request<SyncResponse>("/sync", { method: "POST", body: JSON.stringify({ agentId, selectedSkillIds, confirm: true }) })
}
function linkPreflight(spec: LinkSpec): Promise<LinkPreflightResponse> {
  return request<LinkPreflightResponse>("/links/preflight", { method: "POST", body: JSON.stringify(spec) })
}
function createLink(spec: LinkSpec): Promise<LinkCreateResponse> {
  return request<LinkCreateResponse>("/links/create", { method: "POST", body: JSON.stringify(spec) })
}
function deleteLink(host: HostKind, path: string): Promise<LinkDeleteResponse> {
  return request<LinkDeleteResponse>("/links/delete", { method: "POST", body: JSON.stringify({ host, path }) })
}
function scanLinks(host: HostKind, path: string, recursive: boolean): Promise<LinkScanResponse> {
  return request<LinkScanResponse>("/links/scan", { method: "POST", body: JSON.stringify({ host, path, recursive }) })
}
function convertAgentLink(agentId: string, name: string): Promise<AgentLinkResponse> {
  return request<AgentLinkResponse>("/agent-links/convert", { method: "POST", body: JSON.stringify({ agentId, name }) })
}
function deleteAgentLink(agentId: string, skill: string): Promise<AgentLinkResponse> {
  return request<AgentLinkResponse>("/agent-links/delete", { method: "POST", body: JSON.stringify({ agentId, skill }) })
}

export const api = { init, vault, config, putConfig, agent, plan, executeSync, linkPreflight, createLink, deleteLink, scanLinks, convertAgentLink, deleteAgentLink }
