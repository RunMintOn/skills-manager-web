import type { AgentEntry, AgentScan, ComparisonResult, ComparisonRow, ComparisonState, VaultScan } from "./types.js"
const STATES: ComparisonState[] = ["linked", "pending", "local-dir", "external-link", "broken-link", "invalid"]
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
function stateOf(entry: AgentEntry): ComparisonState { return entry.kind === "repo-link" ? "linked" : entry.kind === "repo-copy" ? "local-dir" : entry.kind }
export function buildComparison(vault: VaultScan, agent: AgentScan): ComparisonResult {
  const byId = new Map<string, AgentEntry[]>(); const byName = new Map<string, AgentEntry[]>()
  for (const entry of agent.entries) { if (entry.skillId) byId.set(entry.skillId, [...(byId.get(entry.skillId) ?? []), entry]); byName.set(entry.name, [...(byName.get(entry.name) ?? []), entry]) }
  const rows: ComparisonRow[] = vault.skills.map((skill) => {
    const linked = byId.get(skill.id) ?? []; const sameName = byName.get(skill.id) ?? []; const risks: string[] = []; let state: ComparisonState
    if (skill.validity === "invalid") { state = "invalid"; risks.push(...skill.issues.map((item) => item.message)) }
    else if (linked.length) { state = linked.some((e) => e.kind === "repo-link") ? "linked" : stateOf(linked[0]!); if (linked.length > 1) risks.push("Multiple Agent entries point to this Skill ID.") }
    else if (sameName.length) { state = stateOf(sameName[0]!); risks.push(...sameName.flatMap((entry) => entry.issues.map((item) => item.message))) }
    else state = "pending"
    return { skillId: skill.id, skillPath: skill.relativePath, collection: skill.collection, state, agentEntryPaths: [...new Set([...linked, ...sameName].map((entry) => entry.relativePath))].sort(compare), risks: [...new Set(risks)] }
  }).sort((a, b) => compare(a.skillPath, b.skillPath))
  const consumed = new Set(rows.flatMap((row) => row.agentEntryPaths)); const known = new Set(vault.skills.map((skill) => skill.id))
  const actualOnly = agent.entries.filter((entry) => !consumed.has(entry.relativePath) && (!entry.skillId || !known.has(entry.name))).sort((a, b) => compare(a.relativePath, b.relativePath))
  const summary = Object.fromEntries(STATES.map((state) => [state, 0])) as Record<ComparisonState, number>; rows.forEach((row) => { summary[row.state] += 1 })
  const actualSummary = { "local-dir": actualOnly.filter((e) => e.kind === "local-dir" || e.kind === "repo-copy").length, "external-link": actualOnly.filter((e) => e.kind === "external-link").length, "broken-link": actualOnly.filter((e) => e.kind === "broken-link").length, invalid: actualOnly.filter((e) => e.kind === "invalid").length }
  return { agentId: agent.id, rows, actualOnly, summary, actualSummary, issueCount: rows.reduce((sum, row) => sum + row.risks.length, 0) + agent.summary.issueCount }
}
export function comparisonRowForSkill(comparison: ComparisonResult, id: string): ComparisonRow | undefined { return comparison.rows.find((row) => row.skillId === id) }
