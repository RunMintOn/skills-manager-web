import { access, constants } from "node:fs"
import { lstat, readFile, readdir } from "node:fs/promises"
import { getHostPathAdapter, isInside, safeRealpath, toStableRelative, type HostPathAdapter } from "./host.ts"
import { parseFrontmatter } from "./frontmatter.ts"
import type { Frontmatter, SkillIssue, VaultCollection, VaultConfig, VaultScan, VaultSkill, VaultValidationIssue } from "./types.ts"

const SKILL_FILE = "SKILL.md"
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const exists = async (path: string) => new Promise<boolean>((resolve) => access(path, constants.F_OK, (error) => resolve(!error)))
const skipName = (name: string) => name === "node_modules" || name.startsWith(".")
function collectionFor(relative: string): string { const first = relative.split("/")[0]; return relative.includes("/") && first ? first : "Loose Skills" }
export function classifyCollection(relativePath: string): string { return collectionFor(relativePath) }
async function readSkill(adapter: HostPathAdapter, directory: string): Promise<{ frontmatter: Frontmatter; issues: SkillIssue[] }> {
  const file = adapter.join(directory, SKILL_FILE)
  try {
    const stat = await lstat(file)
    if (!stat.isFile()) throw new Error("SKILL.md is not a regular file")
    const frontmatter = parseFrontmatter(await readFile(file, "utf8")); const issues: SkillIssue[] = []
    if (!frontmatter.present) issues.push({ code: "frontmatter-missing", severity: "error", message: "SKILL.md has no YAML frontmatter block." })
    if (frontmatter.errors.length) issues.push({ code: "frontmatter-malformed", severity: "error", message: frontmatter.errors.join("; ") })
    if (!frontmatter.name) issues.push({ code: "name-missing", severity: "error", message: "SKILL.md frontmatter must contain a non-empty name." })
    return { frontmatter, issues }
  } catch (error) {
    return { frontmatter: { present: false, raw: "", fields: {}, errors: ["skill-read-error"] }, issues: [{ code: "skill-read-error", severity: "error", message: `Cannot read SKILL.md: ${error instanceof Error ? error.message : String(error)}` }] }
  }
}
function createSkill(adapter: HostPathAdapter, root: string, directory: string, frontmatter: Frontmatter, initial: SkillIssue[]): VaultSkill {
  const relativePath = toStableRelative(adapter, adapter.relative(root, directory)); const directoryName = adapter.basename(directory); const issues = [...initial]
  if (frontmatter.name && frontmatter.name !== directoryName) issues.push({ code: "name-mismatch", severity: "error", message: `Directory name \"${directoryName}\" must exactly equal frontmatter name \"${frontmatter.name}\".` })
  return { id: frontmatter.name ?? relativePath, relativePath, absolutePath: directory, collection: collectionFor(relativePath), directoryName, frontmatter, name: frontmatter.name, description: frontmatter.description, validity: issues.length ? "invalid" : "valid", issues }
}
/** Read-only recursive Vault scan. It never follows directory symlinks or mutates files. */
export async function scanVault(config: VaultConfig): Promise<VaultScan> {
  const adapter = getHostPathAdapter(config.host); const root = adapter.normalize(config.path)
  const result: VaultScan = { path: root, host: config.host, supported: adapter.supportedRuntime, rootExists: false, skills: [], collections: [], duplicateIds: [], issues: [], summary: { total: 0, valid: 0, invalid: 0, collections: 0, duplicateIds: 0, issueCount: 0 } }
  if (!adapter.supportedRuntime) { result.issues.push({ code: "vault-unreadable", severity: "error", message: `The ${config.host} adapter is unavailable on runtime ${process.platform}; scan not attempted.` }); result.summary.issueCount = 1; return result }
  if (!(await exists(root))) { result.issues.push({ code: "vault-missing", severity: "error", message: `Vault path does not exist: ${root}` }); result.summary.issueCount = 1; return result }
  const stat = await lstat(root).catch(() => undefined); if (!stat?.isDirectory()) { result.issues.push({ code: "vault-unreadable", severity: "error", message: `Vault path is not a directory: ${root}` }); result.summary.issueCount = 1; return result }
  result.rootExists = true; result.canonicalPath = (await safeRealpath(root)) ?? adapter.resolve(root)
  const discovered: VaultSkill[] = []
  const walk = async (directory: string): Promise<void> => {
    let entries: import("node:fs").Dirent[]
    try { entries = await readdir(directory, { withFileTypes: true }) } catch (error) { result.issues.push({ code: "vault-unreadable", severity: "error", relativePath: toStableRelative(adapter, adapter.relative(root, directory)), message: `Cannot read Vault directory: ${error instanceof Error ? error.message : String(error)}` }); return }
    entries.sort((a, b) => compare(a.name, b.name))
    for (const entry of entries) {
      if (skipName(entry.name)) continue
      const child = adapter.join(directory, entry.name); const childStat = await lstat(child).catch(() => undefined)
      if (!childStat?.isDirectory() || childStat.isSymbolicLink()) continue
      if (await exists(adapter.join(child, SKILL_FILE))) { const read = await readSkill(adapter, child); discovered.push(createSkill(adapter, root, child, read.frontmatter, read.issues)) }
      await walk(child)
    }
  }
  await walk(root)
  for (const skill of discovered) skill.canonicalPath = (await safeRealpath(skill.absolutePath)) ?? adapter.resolve(skill.absolutePath)
  const byId = new Map<string, VaultSkill[]>()
  for (const skill of discovered) if (skill.frontmatter.name) byId.set(skill.frontmatter.name, [...(byId.get(skill.frontmatter.name) ?? []), skill])
  for (const [id, group] of byId) if (group.length > 1) { result.duplicateIds.push(id); for (const skill of group) { skill.validity = "invalid"; skill.issues.push({ code: "duplicate-id", severity: "error", message: `Skill ID \"${id}\" is declared by ${group.length} Vault directories.` }) } }
  result.duplicateIds.sort(compare); result.skills = discovered.sort((a, b) => compare(a.relativePath, b.relativePath))
  result.issues.push(...result.skills.flatMap((skill): VaultValidationIssue[] => skill.issues.map((issue) => ({ code: issue.code, severity: issue.severity, relativePath: skill.relativePath, skillId: skill.id, message: issue.message }))))
  const collections = new Map<string, VaultCollection>()
  for (const skill of result.skills) { const current = collections.get(skill.collection) ?? { id: skill.collection, label: skill.collection, skillIds: [], validCount: 0, invalidCount: 0 }; current.skillIds.push(skill.id); if (skill.validity === "valid") current.validCount += 1; else current.invalidCount += 1; collections.set(skill.collection, current) }
  result.collections = [...collections.values()].sort((a, b) => compare(a.id, b.id)); for (const collection of result.collections) collection.skillIds.sort(compare)
  result.summary = { total: result.skills.length, valid: result.skills.filter((skill) => skill.validity === "valid").length, invalid: result.skills.filter((skill) => skill.validity === "invalid").length, collections: result.collections.length, duplicateIds: result.duplicateIds.length, issueCount: result.issues.length }
  return result
}
export function findVaultSkillById(vault: VaultScan, id: string): VaultSkill | undefined { return vault.skills.find((skill) => skill.id === id && skill.validity === "valid") }
export function findVaultSkillByPath(vault: VaultScan, canonicalPath: string): VaultSkill | undefined { return vault.skills.find((skill) => skill.validity === "valid" && skill.canonicalPath === canonicalPath) }
export function vaultContainsPath(vault: VaultScan, candidate: string): boolean { const adapter = getHostPathAdapter(vault.host); return Boolean(vault.canonicalPath && isInside(adapter, vault.canonicalPath, candidate)) }
