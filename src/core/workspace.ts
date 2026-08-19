import { readConfig, readConfigOrFixture } from "./config.js"
import { scanAgent } from "./agent.js"
import { scanVault } from "./vault.js"
import { buildComparison } from "./compare.js"
import type { AgentScan, LoadedConfig, StatusSnapshot, WorkspaceSnapshot } from "./types.js"
export async function scanWorkspace(config: LoadedConfig): Promise<WorkspaceSnapshot> { const vault = await scanVault(config.vault); const agents = await Promise.all(config.agents.map((agent) => scanAgent(agent, vault))); return { config, vault, agents } }
export async function scanWorkspaceFromConfig(path: string, fixtureWhenMissing = true): Promise<WorkspaceSnapshot> { return scanWorkspace(await (fixtureWhenMissing ? readConfigOrFixture(path) : readConfig(path))) }
export function selectedAgent(snapshot: WorkspaceSnapshot): AgentScan | undefined { const id = snapshot.config.selectedAgentId ?? snapshot.config.agents[0]?.id; return snapshot.agents.find((agent) => agent.id === id) ?? snapshot.agents[0] }
export function buildStatusSnapshot(snapshot: WorkspaceSnapshot): StatusSnapshot { const agent = selectedAgent(snapshot); return { schemaVersion: 1, tool: "skill-manager-web", execution: "preview-only", config: { path: snapshot.config.configPath, exists: snapshot.config.exists, ...(snapshot.config.selectedAgentId ? { selectedAgentId: snapshot.config.selectedAgentId } : {}), agentCount: snapshot.config.agents.length }, vault: snapshot.vault, agents: snapshot.agents, ...(agent ? { selectedAgentId: agent.id, comparison: buildComparison(snapshot.vault, agent) } : {}), safety: { vault: "read-only", agents: "read-only-scan", sync: "preview-only" } } }
