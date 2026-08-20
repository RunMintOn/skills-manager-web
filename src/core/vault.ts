import { access, constants } from "node:fs"
import { lstat, readFile, readdir } from "node:fs/promises"
import { getHostPathAdapter, isInside, safeRealpath, toStableRelative, type HostPathAdapter } from "./host.ts"
import { parseFrontmatter } from "./frontmatter.ts"
import type { Frontmatter, SkillIssue, VaultCollection, VaultConfig, VaultScan, VaultSkill, VaultValidationIssue } from "./types.ts"

const SKILL_FILE = "SKILL.md"
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const exists = async (path: string) => new Promise<boolean>((resolve) => access(path, constants.F_OK, (error) => resolve(!error)))
// Directory discovery rules follow the wsl-symlink-manager semantics (collect_skill_dirs / scan_vault):
// recursive at any depth, dot directories (e.g. `.agents/`) are valid containers; only `.git` and
// `node_modules` are excluded; Vault top-level dot directories are skipped entirely.
const skipName = (name: string) => name === ".git" || name === "node_modules"
const skipTopLevel = (name: string) => name.startsWith(".")
function collectionFor(relative: string): string { const first = relative.split("/")[0]; return relative.includes("/") && first ? first : "Loose Skills" }
export function classifyCollection(relativePath: string): string { return collectionFor(relativePath) }
async function readSkill(adapter: HostPathAdapter, directory: string): Promise<{ frontmatter: Frontmatter; issues: SkillIssue[] }> {
  const file = adapter.join(directory, SKILL_FILE)
  try {
    const stat = await lstat(file)
    if (!stat.isFile()) throw new Error("SKILL.md is not a regular file")
    const frontmatter = parseFrontmatter(await readFile(file, "utf8")); const issues: SkillIssue[] = []
    // Validity judgment per the reference semantics: missing/unreadable frontmatter or a missing
    // name = invalid; quirky YAML is not an error by itself.
    if (!frontmatter.name) issues.push({ code: "name-missing", severity: "error", message: "SKILL.md has no non-empty name." })
    return { frontmatter, issues }
  } catch (error) {
    return { frontmatter: { present: false, raw: "", fields: {}, errors: [] }, issues: [{ code: "skill-read-error", severity: "error", message: `Cannot read SKILL.md: ${error instanceof Error ? error.message : String(error)}` }] }
  }
}
function createSkill(adapter: HostPathAdapter, root: string, directory: string, frontmatter: Frontmatter, initial: SkillIssue[]): VaultSkill {
  const relativePath = toStableRelative(adapter, adapter.relative(root, directory)); const directoryName = adapter.basename(directory); const issues = [...initial]
  // Exact match (including case) is required for validity; a mismatch is invalid, not a warning.
  if (frontmatter.name && frontmatter.name !== directoryName) issues.push({ code: "name-mismatch", severity: "error", message: `Directory name \"${directoryName}\" does not exactly match frontmatter name \"${frontmatter.name}\".` })
  return { id: frontmatter.name ?? relativePath, relativePath, absolutePath: directory, collection: collectionFor(relativePath), directoryName, frontmatter, name: frontmatter.name, description: frontmatter.description, validity: issues.length ? "invalid" : "valid", issues }
}
/** Read-only recursive Vault scan. It never follows directory symlinks or mutates files. */
export async function scanVault(config: VaultConfig): Promise<VaultScan> {
  const adapter = getHostPathAdapter(config.host); const root = adapter.normalize(config.path)
  const result: VaultScan = { path: root, host: config.host, supported: adapter.supportedRuntime, rootExists: false, skills: [], collections: [], duplicateIds: [], issues: [], summary: { total: 0, valid: 0, invalid: 0, collections: 0, duplicateIds: 0, errors: 0, warnings: 0, ignoredDirs: 0, issueCount: 0 } }
  if (!adapter.supportedRuntime) { result.issues.push({ code: "vault-unreadable", severity: "error", message: `The ${config.host} adapter is unavailable on runtime ${process.platform}; scan not attempted.` }); result.summary.issueCount = 1; return result }
  if (!(await exists(root))) { result.issues.push({ code: "vault-missing", severity: "error", message: `Vault path does not exist: ${root}` }); result.summary.issueCount = 1; return result }
  const stat = await lstat(root).catch(() => undefined); if (!stat?.isDirectory()) { result.issues.push({ code: "vault-unreadable", severity: "error", message: `Vault path is not a directory: ${root}` }); result.summary.issueCount = 1; return result }
  result.rootExists = true; result.canonicalPath = (await safeRealpath(root)) ?? adapter.resolve(root)
  const discovered: VaultSkill[] = []
  const walk = async (directory: string, depth: number): Promise<void> => {
    let entries: import("node:fs").Dirent[]
    try { entries = await readdir(directory, { withFileTypes: true }) } catch (error) { result.issues.push({ code: "vault-unreadable", severity: "error", relativePath: toStableRelative(adapter, adapter.relative(root, directory)), message: `Cannot read Vault directory: ${error instanceof Error ? error.message : String(error)}` }); return }
    entries.sort((a, b) => compare(a.name, b.name))
    for (const entry of entries) {
      if (skipName(entry.name) || (depth === 0 && skipTopLevel(entry.name))) { result.summary.ignoredDirs += 1; continue }
      const child = adapter.join(directory, entry.name); const childStat = await lstat(child).catch(() => undefined)
      if (!childStat?.isDirectory() || childStat.isSymbolicLink()) continue
      if (await exists(adapter.join(child, SKILL_FILE))) { const read = await readSkill(adapter, child); discovered.push(createSkill(adapter, root, child, read.frontmatter, read.issues)) }
      await walk(child, depth + 1)
    }
  }
  await walk(root, 0)
  for (const skill of discovered) skill.canonicalPath = (await safeRealpath(skill.absolutePath)) ?? adapter.resolve(skill.absolutePath)
  // Duplicate IDs are not errors (per reference): same-id multi-source is normal, all stay valid,
  // disambiguation happens at use time. The duplicate list is kept for display only.
  const byId = new Map<string, VaultSkill[]>()
  for (const skill of discovered) if (skill.frontmatter.name) byId.set(skill.frontmatter.name, [...(byId.get(skill.frontmatter.name) ?? []), skill])
  for (const [id, group] of byId) if (group.length > 1) result.duplicateIds.push(id)
  result.duplicateIds.sort(compare); result.skills = discovered.sort((a, b) => compare(a.relativePath, b.relativePath))
  result.issues.push(...result.skills.flatMap((skill): VaultValidationIssue[] => skill.issues.map((issue) => ({ code: issue.code, severity: issue.severity, relativePath: skill.relativePath, skillId: skill.id, message: issue.message }))))
  const collections = new Map<string, VaultCollection>()
  for (const skill of result.skills) { const current = collections.get(skill.collection) ?? { id: skill.collection, label: skill.collection, skillIds: [], validCount: 0, invalidCount: 0 }; current.skillIds.push(skill.id); if (skill.validity === "valid") current.validCount += 1; else current.invalidCount += 1; collections.set(skill.collection, current) }
  result.collections = [...collections.values()].sort((a, b) => compare(a.id, b.id)); for (const collection of result.collections) collection.skillIds.sort(compare)
  const errors = result.issues.filter((issue) => issue.severity === "error").length
  const warnings = result.issues.filter((issue) => issue.severity === "warning").length
  result.summary = { total: result.skills.length, valid: result.skills.filter((skill) => skill.validity === "valid").length, invalid: result.skills.filter((skill) => skill.validity === "invalid").length, collections: result.collections.length, duplicateIds: result.duplicateIds.length, errors, warnings, ignoredDirs: result.summary.ignoredDirs, issueCount: result.issues.length }
  return result
}
export function findVaultSkillById(vault: VaultScan, id: string): VaultSkill | undefined { return vault.skills.find((skill) => skill.id === id && skill.validity === "valid") }
export function findVaultSkillCandidates(vault: VaultScan, id: string): VaultSkill[] { return vault.skills.filter((skill) => skill.id === id && skill.validity === "valid") }
/** 按身份键（relativePath，全局唯一）查找；同名 skill 也能精确命中各自目录。 */
export function findVaultSkillByKey(vault: VaultScan, key: string): VaultSkill | undefined { return vault.skills.find((skill) => skill.relativePath === key && skill.validity === "valid") }
export function findVaultSkillByPath(vault: VaultScan, canonicalPath: string): VaultSkill | undefined { return vault.skills.find((skill) => skill.validity === "valid" && skill.canonicalPath === canonicalPath) }
export function vaultContainsPath(vault: VaultScan, candidate: string): boolean { const adapter = getHostPathAdapter(vault.host); return Boolean(vault.canonicalPath && isInside(adapter, vault.canonicalPath, candidate)) }
