import { appendSafeChild, getHostPathAdapter } from "./host.ts"
import { createLinkOperation } from "./link-plan.ts"
import { buildComparison } from "./compare.ts"
import { findVaultSkillByKey } from "./vault.ts"
import type { AgentScan, ComparisonResult, LinkOperationPlan, PlanAction, SkillManagerConfig, SyncPlan, SyncPlanOperation, VaultScan } from "./types.ts"
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
function blocked(id: string, skillKey: string, agentId: string, risks: string[], skillPath?: string): SyncPlanOperation { return { id, skillKey, skillPath, agentId, action: "blocked", risks, execution: "not-run" } }
export function buildSyncPlan(input: { config: SkillManagerConfig; vault: VaultScan; agent: AgentScan; comparison: ComparisonResult; selectedSkillIds: string[] }): SyncPlan {
  // selectedSkillIds 的身份键是 Vault Skill 的 relativePath（唯一；同名 skill 各自独立）。
  const selectedSkillIds = [...new Set(input.selectedSkillIds)].sort(compare); const known = new Set(input.vault.skills.map((skill) => skill.relativePath)); const unknownSkillIds = selectedSkillIds.filter((key) => !known.has(key)); const agentConfig = input.config.agents.find((item) => item.id === input.agent.id); if (!agentConfig) throw new Error(`unknown agent id: ${input.agent.id}`)
  const operations: SyncPlanOperation[] = []
  for (const skillKey of selectedSkillIds) {
    const id = `${input.agent.id}:${skillKey}`; const skill = findVaultSkillByKey(input.vault, skillKey); const row = input.comparison.rows.find((item) => item.skillKey === skillKey)
    if (!skill) { operations.push(blocked(id, skillKey, input.agent.id, [known.has(skillKey) ? "Skill is invalid and cannot be synchronized." : "Skill is not present in the Vault scan."])); continue }
    const risks = [...(row?.risks ?? [])]
    if (input.vault.host !== agentConfig.host) { operations.push(blocked(id, skillKey, input.agent.id, [...risks, "连接操作暂时只支持同一环境：Baseline 与 Agent 必须使用相同 Host"], skill.relativePath)); continue }
    if (!input.agent.supported || !input.agent.rootExists) { operations.push(blocked(id, skillKey, input.agent.id, [...risks, !input.agent.supported ? "Agent host adapter is unavailable on this runtime." : "Agent path is missing or unreadable; this preview never creates it."], skill.relativePath)); continue }
    if (row?.state === "linked") { operations.push({ id, skillKey, skillPath: skill.relativePath, agentId: input.agent.id, action: "already-linked", targetPath: skill.absolutePath, risks, execution: "not-run" }); continue }
    if (row && row.state !== "pending") { operations.push(blocked(id, skillKey, input.agent.id, risks.length ? risks : [`Agent state is ${row.state}; destination is not safe to replace.`], skill.relativePath)); continue }
    try {
      const adapter = getHostPathAdapter(agentConfig.host); const linkPath = appendSafeChild(adapter, adapter.normalize(agentConfig.path), skill.name ?? skill.id); const link: LinkOperationPlan = createLinkOperation({ vaultHost: input.vault.host, agentHost: agentConfig.host, targetPath: skill.absolutePath, linkPath }); operations.push({ id, skillKey, skillPath: skill.relativePath, agentId: input.agent.id, action: "create-link", targetPath: skill.absolutePath, linkPath: link.linkPath, link, risks, execution: "not-run" })
    } catch (error) { operations.push(blocked(id, skillKey, input.agent.id, [...risks, error instanceof Error ? error.message : String(error)], skill.relativePath)) }
  }
  return { schemaVersion: 1, mode: "preview-only", agentId: input.agent.id, selectedSkillIds, unknownSkillIds, operations, safety: { filesystemWrites: "disabled", shell: "never", windowsExecution: "manual-only", note: "This slice only produces a plan; no operation was executed." } }
}
export function buildPlanForAgent(input: { config: SkillManagerConfig; vault: VaultScan; agent: AgentScan; selectedSkillIds: string[] }): SyncPlan { return buildSyncPlan({ ...input, comparison: buildComparison(input.vault, input.agent) }) }