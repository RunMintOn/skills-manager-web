import type { AgentConfig, AgentScan, ComparisonResult, HostKind, SkillManagerConfig, VaultScan } from "../core/types.ts"

const API_PORT = import.meta.env.VITE_API_PORT || "8787"
const API_ROOT = `http://${window.location.hostname || "127.0.0.1"}:${API_PORT}/api`
export interface InitResponse {
  schemaVersion: 1
  service: { host: string; port: number; execution: "preview-only" }
  config: { configPath: string; exists: boolean; config: SkillManagerConfig }
  vault: { path: string; host: HostKind; summary: VaultScan["summary"] }
  agents: Array<AgentConfig & { issueCount: number }>
  selectedAgentId?: string
  safety: { vault: string; sync: string; filesystemWrites: string }
}
export interface ConfigResponse { schemaVersion: 1; configPath: string; exists: boolean; config: SkillManagerConfig }
export interface AgentResponse { schemaVersion: 1; agent: AgentScan; comparison: ComparisonResult; execution: "read-only" }
export interface PlanResponse { schemaVersion: 1; plan: unknown; execution: "not-run" }
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_ROOT}${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } })
  const body = await response.json() as T & { error?: { message?: string } }
  if (!response.ok) throw new Error(body.error?.message ?? `API ${response.status}`)
  return body
}
export const api = {
  init: () => request<InitResponse>("/init"),
  vault: () => request<{ schemaVersion: 1; vault: VaultScan }>("/vault"),
  config: () => request<ConfigResponse>("/config"),
  putConfig: (config: SkillManagerConfig) => request<ConfigResponse>("/config", { method: "PUT", body: JSON.stringify(config) }),
  agent: (id: string) => request<AgentResponse>(`/agent/${encodeURIComponent(id)}`),
  plan: (agentId: string, selectedSkillIds: string[]) => request<PlanResponse>("/plan", { method: "POST", body: JSON.stringify({ agentId, selectedSkillIds }) }),
}
