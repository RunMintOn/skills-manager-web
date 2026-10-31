import type { AgentEntry, ComparisonResult, SkillIssue, VaultSkill } from "../core/types"

export const stateLabels: Record<string, string> = {
  linked: "已链接", pending: "待链接", valid: "有效", invalid: "无效",
  "local-dir": "本地目录", "external-link": "外部链接", "broken-link": "断链",
}
export const kindLabels: Record<string, string> = {
  "repo-link": "已链接", "repo-copy": "本地拷贝", "local-dir": "本地目录",
  "external-link": "外部链接", "broken-link": "断链", invalid: "无效",
}
const issueLabels: Record<string, string> = {
  "frontmatter-missing": "缺少 frontmatter",
  "frontmatter-malformed": "frontmatter 格式有误",
  "name-missing": "frontmatter 缺少 name",
  "name-mismatch": "目录名与 name 不一致",
  "duplicate-id": "Skill 名称重复",
  "skill-read-error": "无法读取 SKILL.md",
  "agent-root-missing": "Agent 目录尚未创建",
  "agent-root-unreadable": "无法读取 Agent 目录",
  "local-directory": "本地目录，不是 Vault 链接",
  "external-link": "链接指向 Vault 之外",
  "broken-link": "链接目标不存在或无法读取",
  "invalid-entry": "条目无效",
  "cross-host-link": "链接与 Vault 不在同一环境",
  "duplicate-skill-entry": "多个条目指向同一个 Skill",
  "invalid-skill-metadata": "Skill 元数据无效",
}
export function issueText(issue: { code: string; message: string }): string {
  return issueLabels[issue.code] ?? issue.message
}
export function stateTone(state: string): string {
  if (state === "linked" || state === "valid" || state === "repo-link") return "green"
  if (state === "invalid" || state === "broken-link") return "red"
  if (state === "local-dir" || state === "external-link" || state === "repo-copy") return "amber"
  return "gray"
}
export function skillState(skill: VaultSkill, comparison: ComparisonResult | null): string {
  return comparison?.rows.find((row) => row.skillKey === skill.relativePath)?.state ?? (skill.validity === "invalid" ? "invalid" : "pending")
}
export function pendingSkills(skills: VaultSkill[], comparison: ComparisonResult | null): VaultSkill[] {
  return comparison ? skills.filter((skill) => skill.validity === "valid" && skillState(skill, comparison) === "pending") : []
}
export function entryForSkill(entries: AgentEntry[], skill: VaultSkill): AgentEntry | undefined {
  return entries.find((entry) => entry.skillKey === skill.relativePath || (!entry.skillKey && entry.name === skill.directoryName))
}
export function shortPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+(?=\/|$)/, "~")
}
export function validationLabel(issues: SkillIssue[]): string {
  return issues.some((issue) => issue.severity === "error") ? "无效" : issues.length ? "有警告" : "有效"
}
