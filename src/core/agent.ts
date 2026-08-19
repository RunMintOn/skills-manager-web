import { access, constants } from "node:fs"
import { lstat, readdir, readFile } from "node:fs/promises"
import { getHostPathAdapter, isInside, safeRealpath, toStableRelative, type HostPathAdapter } from "./host.js"
import { parseFrontmatter } from "./frontmatter.js"
import { findVaultSkillById } from "./vault.js"
import type { AgentConfig, AgentEntry, AgentEntryIssue, AgentScan, Frontmatter, VaultScan, VaultSkill } from "./types.js"

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const exists = async (path: string) => new Promise<boolean>((resolve) => access(path, constants.F_OK, (error) => resolve(!error)))
const issue = (code: AgentEntryIssue["code"], severity: AgentEntryIssue["severity"], message: string): AgentEntryIssue => ({ code, severity, message })
const comparable = (adapter: HostPathAdapter, value: string) => adapter.host === "windows" ? adapter.normalize(value).toLocaleLowerCase("en-US") : adapter.normalize(value)
function findByCanonical(vault: VaultScan, target: string, adapter: HostPathAdapter): VaultSkill | undefined { const normalized = comparable(adapter, target); return vault.skills.find((skill) => skill.validity === "valid" && comparable(adapter, skill.canonicalPath ?? skill.absolutePath) === normalized) }
function inVault(vault: VaultScan, target: string, adapter: HostPathAdapter): boolean { return vault.host === adapter.host && Boolean(vault.canonicalPath && isInside(adapter, vault.canonicalPath, target)) }
async function readDirectoryMetadata(adapter: HostPathAdapter, path: string): Promise<{ frontmatter?: Frontmatter; issues: AgentEntryIssue[] }> {
  const skillFile = adapter.join(path, "SKILL.md"); if (!(await exists(skillFile))) return { issues: [] }
  try { const frontmatter = parseFrontmatter(await readFile(skillFile, "utf8")); const issues: AgentEntryIssue[] = []; if (!frontmatter.present || frontmatter.errors.length || !frontmatter.name) issues.push(issue("invalid-skill-metadata", "error", "Agent directory contains invalid SKILL.md frontmatter.")); return { frontmatter, issues } } catch (error) { return { issues: [issue("invalid-skill-metadata", "error", `Cannot read Agent SKILL.md: ${error instanceof Error ? error.message : String(error)}`)] } }
}
function baseEntry(adapter: HostPathAdapter, root: string, name: string, absolutePath: string): Pick<AgentEntry, "name" | "relativePath" | "absolutePath"> { return { name, relativePath: toStableRelative(adapter, adapter.relative(root, absolutePath)), absolutePath } }
/** Scan one Agent's direct children, deliberately never following links as directories. */
export async function scanAgent(config: AgentConfig, vault: VaultScan): Promise<AgentScan> {
  const adapter = getHostPathAdapter(config.host); const root = adapter.normalize(config.path)
  const result: AgentScan = { id: config.id, name: config.name, path: root, host: config.host, supported: adapter.supportedRuntime, rootExists: false, entries: [], issues: [], summary: { total: 0, repoLinks: 0, repoCopies: 0, localDirs: 0, externalLinks: 0, brokenLinks: 0, invalid: 0, issueCount: 0 } }
  if (!adapter.supportedRuntime) { result.issues.push(issue("agent-root-unreadable", "error", `The ${config.host} adapter is unavailable on runtime ${process.platform}; scan not attempted.`)); result.summary.issueCount = 1; return result }
  if (!(await exists(root))) { result.issues.push(issue("agent-root-missing", "error", `Agent path does not exist: ${root}`)); result.summary.issueCount = 1; return result }
  const rootStat = await lstat(root).catch(() => undefined); if (!rootStat?.isDirectory()) { result.issues.push(issue("agent-root-unreadable", "error", `Agent path is not a directory: ${root}`)); result.summary.issueCount = 1; return result }
  result.rootExists = true; result.canonicalPath = (await safeRealpath(root)) ?? adapter.resolve(root)
  let entries: import("node:fs").Dirent[]
  try { entries = await readdir(root, { withFileTypes: true }) } catch (error) { result.issues.push(issue("agent-root-unreadable", "error", `Cannot read Agent path: ${error instanceof Error ? error.message : String(error)}`)); result.summary.issueCount = 1; return result }
  entries.sort((a, b) => compare(a.name, b.name))
  for (const item of entries) {
    if (item.name === "." || item.name === "..") continue
    const path = adapter.join(root, item.name); const stat = await lstat(path).catch(() => undefined)
    if (!stat) { result.entries.push({ ...baseEntry(adapter, root, item.name, path), kind: "invalid", issues: [issue("invalid-entry", "error", "Entry disappeared while being scanned.")] }); continue }
    const entryIssues: AgentEntryIssue[] = []
    if (stat.isSymbolicLink()) {
      const target = await safeRealpath(path)
      if (!target) { result.entries.push({ ...baseEntry(adapter, root, item.name, path), kind: "broken-link", issues: [issue("broken-link", "error", "Link target does not exist or cannot be resolved.")] }); continue }
      if (vault.host !== config.host) { result.entries.push({ ...baseEntry(adapter, root, item.name, path), kind: "invalid", targetPath: target, issues: [issue("cross-host-link", "error", `Agent host ${config.host} and Vault host ${vault.host} require an explicit adapter.`)] }); continue }
      if (inVault(vault, target, adapter)) {
        const targetSkill = findByCanonical(vault, target, adapter)
        if (targetSkill) result.entries.push({ ...baseEntry(adapter, root, item.name, path), kind: "repo-link", targetPath: target, targetVaultRelativePath: targetSkill.relativePath, skillId: targetSkill.id, issues: entryIssues })
        else result.entries.push({ ...baseEntry(adapter, root, item.name, path), kind: "invalid", targetPath: target, issues: [issue("invalid-entry", "error", "Link points inside the Vault but not to a valid Skill directory.")] })
      } else result.entries.push({ ...baseEntry(adapter, root, item.name, path), kind: "external-link", targetPath: target, issues: [issue("external-link", "warning", "Link points outside the configured Vault.")] })
      continue
    }
    if (stat.isDirectory()) {
      const metadata = await readDirectoryMetadata(adapter, path); entryIssues.push(...metadata.issues)
      if (entryIssues.length) { result.entries.push({ ...baseEntry(adapter, root, item.name, path), kind: "invalid", frontmatter: metadata.frontmatter, issues: entryIssues }); continue }
      const targetSkill = metadata.frontmatter?.name ? findVaultSkillById(vault, metadata.frontmatter.name) : undefined
      if (targetSkill) result.entries.push({ ...baseEntry(adapter, root, item.name, path), kind: "repo-copy", skillId: targetSkill.id, targetVaultRelativePath: targetSkill.relativePath, frontmatter: metadata.frontmatter, issues: [issue("local-directory", "warning", "A real directory contains metadata for a Vault Skill but is not a link.")] })
      else result.entries.push({ ...baseEntry(adapter, root, item.name, path), kind: "local-dir", frontmatter: metadata.frontmatter, issues: [issue("local-directory", "warning", "A real local directory is not a Vault link.")] })
      continue
    }
    result.entries.push({ ...baseEntry(adapter, root, item.name, path), kind: "invalid", issues: [issue("invalid-entry", "error", "Agent entry is neither a directory nor a link.")] })
  }
  const bySkill = new Map<string, AgentEntry[]>(); for (const entry of result.entries) if (entry.skillId) bySkill.set(entry.skillId, [...(bySkill.get(entry.skillId) ?? []), entry])
  for (const [skillId, group] of bySkill) if (group.length > 1) { const duplicate = issue("duplicate-skill-entry", "warning", `Agent contains ${group.length} entries for Skill ID \"${skillId}\".`); result.issues.push(duplicate); for (const entry of group) entry.issues.push(duplicate) }
  result.entries.sort((a, b) => compare(a.relativePath, b.relativePath)); result.summary = { total: result.entries.length, repoLinks: result.entries.filter((e) => e.kind === "repo-link").length, repoCopies: result.entries.filter((e) => e.kind === "repo-copy").length, localDirs: result.entries.filter((e) => e.kind === "local-dir").length, externalLinks: result.entries.filter((e) => e.kind === "external-link").length, brokenLinks: result.entries.filter((e) => e.kind === "broken-link").length, invalid: result.entries.filter((e) => e.kind === "invalid").length, issueCount: result.issues.length + result.entries.reduce((sum, e) => sum + e.issues.length, 0) }
  return result
}
