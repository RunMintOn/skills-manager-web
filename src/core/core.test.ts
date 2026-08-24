import { execFile } from "node:child_process"
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { promisify } from "node:util"
import nodePath from "node:path"
import {
  appendSafeChild,
  buildComparison,
  buildPlanForAgent,
  convertCopyToLink,
  detectPathHost,
  createFixtureConfig,
  createLinkOperation,
  executeDeleteLink,
  executeLink,
  getHostPathAdapter,
  preflightBatchLinks,
  preflightLink,
  scanLinkDirectory,
  scanWindowsDirectory,
  executeMirrorSync,
  isSafeWslPath,
  planMirrorSync,
  windowsPathToWsl,
  parseFrontmatter,
  scanAgent,
  scanVault,
  toggleSelection,
  vaultConfigForHost,
  validateConfig,
} from "./index.ts"
import { fixturePath, resolveConfig } from "./config.ts"

const execFileAsync = promisify(execFile)

async function createWindowsTempDirectory(): Promise<{ windows: string; wsl: string }> {
  const name = `skills-manager-mirror-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const response = await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `$path = Join-Path $env:TEMP '${name}'; [System.IO.Directory]::CreateDirectory($path).FullName`])
  const windows = response.stdout.trim()
  const wsl = windowsPathToWsl(windows)
  if (!wsl) throw new Error("Windows temporary directory is not mounted in WSL")
  return { windows, wsl }
}

function quotePowerShell(value: string): string { return `'${value.replaceAll("'", "''")}'` }
async function createWindowsJunction(linkPath: string, targetPath: string): Promise<void> {
  await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference = 'Stop'; New-Item -ItemType Junction -Path ${quotePowerShell(linkPath)} -Target ${quotePowerShell(targetPath)} | Out-Null`])
}

describe("frontmatter and safe path boundaries", () => {
  it("parses scalar fields without evaluating YAML", () => {
    const parsed = parseFrontmatter("---\nname: '中文 skill'\ndescription: |\n  first line\n  second line\n---\nbody")
    expect(parsed.name).toBe("中文 skill")
    expect(parsed.description).toBe("first line second line")
    expect(parsed.errors).toEqual([])
    expect(parseFrontmatter("# no block").present).toBe(false)
  })

  it("rejects traversal and shell-shaped path segments while preserving Unicode", () => {
    expect(isSafeWslPath("/tmp/a b/$(echo nope)" )).toBe(true)
    expect(isSafeWslPath("/tmp/../escape")).toBe(false)
    expect(() => appendSafeChild(getHostPathAdapter("wsl"), "/tmp/agent", "中文 skill")).not.toThrow()
    expect(() => appendSafeChild(getHostPathAdapter("wsl"), "/tmp/agent", "../escape")).toThrow()
    expect(() => createLinkOperation({ vaultHost: "windows", agentHost: "wsl", targetPath: "C:\\\\Vault\\skill", linkPath: "/tmp/skill" })).not.toThrow()
  })

  it("detects only unambiguous absolute Windows and WSL paths", () => {
    expect(detectPathHost(" C:\\Users\\lee\\skills ")).toBe("windows")
    expect(detectPathHost("\\\\server\\share\\skills")).toBe("windows")
    expect(detectPathHost("/home/lee/skills")).toBe("wsl")
    expect(detectPathHost("relative/skills")).toBeUndefined()
    expect(detectPathHost("C:relative\\skills")).toBeUndefined()
    expect(detectPathHost("")).toBeUndefined()
  })
})

describe("fixture Vault and Agent scans", () => {
  it("finds nested Collections, Loose Skills, invalid metadata and duplicate IDs", async () => {
    const vault = await scanVault({ path: fixturePath("vault"), host: "wsl" })
    expect(vault.rootExists).toBe(true)
    expect(vault.summary).toMatchObject({ total: 7, valid: 3, invalid: 4, duplicateIds: 1, errors: 4, warnings: 0 })
    expect(vault.collections.map((item) => item.label)).toEqual(["Loose Skills", "duplicates", "engineering", "invalid", "operations"])
    expect(vault.skills.find((skill) => skill.id === "unicode-helper")?.collection).toBe("Loose Skills")
    expect(vault.skills.find((skill) => skill.id === "lint-helper")?.relativePath).toBe("engineering/tools/lint-helper")
    expect(vault.duplicateIds).toEqual(["duplicate-skill"])
    // Name mismatch is invalid per the reference semantics (exact match required).
    const brokenDemo = vault.skills.find((skill) => skill.directoryName === "broken-demo")
    expect(brokenDemo?.validity).toBe("invalid")
    expect(brokenDemo?.issues).toMatchObject([{ code: "name-mismatch", severity: "error" }])
  })

  it("collects dot directories at depth, skips them at the vault top level, and ignores .git/node_modules", async () => {
    const root = await mkdtemp(nodePath.join(tmpdir(), "skills-manager-hidden-test-"))
    try {
      await mkdir(nodePath.join(root, "vault", "col", ".agents", "skills", "hidden-one"), { recursive: true })
      await writeFile(nodePath.join(root, "vault", "col", ".agents", "skills", "hidden-one", "SKILL.md"), "---\nname: hidden-one\n---\n")
      await mkdir(nodePath.join(root, "vault", "shown"), { recursive: true })
      await writeFile(nodePath.join(root, "vault", "shown", "SKILL.md"), "---\nname: shown\n---\n")
      await mkdir(nodePath.join(root, "vault", ".top-dot", "skills", "x"), { recursive: true })
      await writeFile(nodePath.join(root, "vault", ".top-dot", "skills", "x", "SKILL.md"), "---\nname: x\n---\n")
      await mkdir(nodePath.join(root, "vault", "repo", "node_modules", "dep"), { recursive: true })
      await writeFile(nodePath.join(root, "vault", "repo", "node_modules", "dep", "SKILL.md"), "---\nname: dep\n---\n")
      await mkdir(nodePath.join(root, "vault", "col2", ".git", "objects"), { recursive: true })
      await writeFile(nodePath.join(root, "vault", "col2", ".git", "objects", "SKILL.md"), "---\nname: noise\n---\n")
      const vault = await scanVault({ path: nodePath.join(root, "vault"), host: "wsl" })
      expect(vault.skills.map((skill) => skill.id).sort()).toEqual(["hidden-one", "shown"])
      expect(vault.skills.find((skill) => skill.id === "hidden-one")?.collection).toBe("col")
      expect(vault.summary.ignoredDirs).toBe(3)
      expect(vault.summary.total).toBe(2)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it("keeps all six Agent entry categories distinct", async () => {
    const vault = await scanVault({ path: fixturePath("vault"), host: "wsl" })
    const agent = await scanAgent({ id: "fixture-agent", name: "Fixture Agent", host: "wsl", path: fixturePath("agents/default") }, vault)
    expect(agent.summary).toMatchObject({ total: 8, repoLinks: 1, repoCopies: 1, localDirs: 1, externalLinks: 1, brokenLinks: 1, invalid: 3 })
    expect(new Set(agent.entries.map((entry) => entry.kind))).toEqual(new Set(["repo-link", "repo-copy", "local-dir", "external-link", "broken-link", "invalid"]))
    expect(agent.entries.find((entry) => entry.name === "code-review")?.skillKey).toBe("engineering/code-review")
    expect(agent.entries.find((entry) => entry.name === "lint-helper")?.kind).toBe("repo-copy")
    expect(agent.entries.find((entry) => entry.name === "lint-helper-copy")?.kind).toBe("invalid")
  })
})

describe("comparison and preview plan", () => {
  it("maps linked, copy/local, pending and invalid states and keeps Agent-only entries", async () => {
    const vault = await scanVault({ path: fixturePath("vault"), host: "wsl" })
    const config = createFixtureConfig()
    const agent = await scanAgent(config.agents[0]!, vault)
    const comparison = buildComparison(vault, agent)
    expect(comparison.summary).toMatchObject({ linked: 1, "local-dir": 1, pending: 1, invalid: 4 })
    expect(comparison.actualOnly.length).toBeGreaterThanOrEqual(4)
    expect(comparison.rows.find((row) => row.skillKey === "unicode-helper")?.state).toBe("pending")
  })

  it("does not match a same-named skill from another collection when the entry is keyed to a different skill", async () => {
    const root = await mkdtemp(nodePath.join(tmpdir(), "skills-manager-dupe-name-test-"))
    try {
      // 两个同名（同 id）skill 分布在不同 collection。
      await mkdir(nodePath.join(root, "vault", "coll-a", "prototype"), { recursive: true })
      await writeFile(nodePath.join(root, "vault", "coll-a", "prototype", "SKILL.md"), "---\nname: prototype\n---\n")
      await mkdir(nodePath.join(root, "vault", "coll-b", "prototype"), { recursive: true })
      await writeFile(nodePath.join(root, "vault", "coll-b", "prototype", "SKILL.md"), "---\nname: prototype\n---\n")
      // Agent 只加载了 coll-a 的那个，且 skillKey 指向 coll-a 的路径。
      await mkdir(nodePath.join(root, "agent"))
      await symlink(nodePath.join(root, "vault", "coll-a", "prototype"), nodePath.join(root, "agent", "prototype"), "dir")
      const vault = await scanVault({ path: nodePath.join(root, "vault"), host: "wsl" })
      const agent = await scanAgent({ id: "a", name: "A", host: "wsl", path: nodePath.join(root, "agent") }, vault)
      const comparison = buildComparison(vault, agent)
      const rowA = comparison.rows.find((row) => row.skillKey === "coll-a/prototype")
      const rowB = comparison.rows.find((row) => row.skillKey === "coll-b/prototype")
      expect(agent.entries[0]?.skillKey).toBe("coll-a/prototype")
      // 被加载的 coll-a 是 linked；未加载的 coll-b 仍是 pending，不能被同名条目冒认。
      expect(rowA?.state).toBe("linked")
      expect(rowB?.state).toBe("pending")
      expect(rowB?.agentEntryPaths).toEqual([])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it("produces typed, not-run operations and never mutates the filesystem", async () => {
    const vault = await scanVault({ path: fixturePath("vault"), host: "wsl" })
    const config = createFixtureConfig(); const agent = await scanAgent(config.agents[0]!, vault)
    const before = await readFile(nodePath.join(fixturePath("agents/default"), "local-notes/README.md"), "utf8")
    const plan = buildPlanForAgent({ config, vault, agent, selectedSkillIds: ["unicode-helper", "engineering/code-review", "engineering/tools/lint-helper", "missing-key"] })
    expect(plan.mode).toBe("preview-only"); expect(plan.safety.filesystemWrites).toBe("disabled")
    expect(plan.operations.map((item) => item.action)).toEqual(["already-linked", "blocked", "blocked", "create-link"])
    const create = plan.operations.find((item) => item.skillKey === "unicode-helper")!
    expect(create.execution).toBe("not-run"); expect(create.link?.kind).toBe("wsl-command"); expect((create.link as { shell: false }).shell).toBe(false)
    expect((create.link as { args: string[] }).args).not.toContain("&&")
    expect(await readFile(nodePath.join(fixturePath("agents/default"), "local-notes/README.md"), "utf8")).toBe(before)
  })
})

describe("real generic link service", () => {
  it("preflights, creates, scans and deletes a file link without deleting its target", async () => {
    const root = await mkdtemp(nodePath.join(tmpdir(), "skills-manager-link-test-"))
    try {
      const target = nodePath.join(root, "source.txt"); const destination = nodePath.join(root, "links"); const link = nodePath.join(destination, "source.txt")
      await mkdir(destination, { recursive: true }); await writeFile(target, "keep me")
      const spec = { targetHost: "wsl" as const, targetPath: target, linkHost: "wsl" as const, linkPath: link }
      expect((await preflightLink(spec)).ready).toBe(true)
      const created = await executeLink(spec); expect(created).toMatchObject({ attempted: true, success: true })
      const scan = await scanLinkDirectory({ host: "wsl", path: destination }); expect(scan.entries).toHaveLength(1); expect(scan.entries[0]).toMatchObject({ kind: "wsl-symlink", targetStatus: "exists", canDelete: true })
      const deleted = await executeDeleteLink({ host: "wsl", path: link }); expect(deleted).toMatchObject({ attempted: true, success: true }); expect(await readFile(target, "utf8")).toBe("keep me")
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it("preflights direct Skill children as flat same-host links", async () => {
    const root = await mkdtemp(nodePath.join(tmpdir(), "skills-manager-batch-link-test-"))
    try {
      const source = nodePath.join(root, "source")
      const destination = nodePath.join(root, "destination")
      await mkdir(nodePath.join(source, "one"), { recursive: true })
      await writeFile(nodePath.join(source, "one", "SKILL.md"), "---\nname: one\n---\n")
      await mkdir(nodePath.join(source, "occupied"), { recursive: true })
      await writeFile(nodePath.join(source, "occupied", "SKILL.md"), "---\nname: occupied\n---\n")
      await mkdir(nodePath.join(source, "no-skill"), { recursive: true })
      await writeFile(nodePath.join(source, "no-skill", "README.md"), "ignore")
      await mkdir(nodePath.join(source, "nested", "two"), { recursive: true })
      await writeFile(nodePath.join(source, "nested", "two", "SKILL.md"), "---\nname: two\n---\n")
      await mkdir(nodePath.join(destination, "occupied"), { recursive: true })
      await writeFile(nodePath.join(destination, "occupied", "keep.txt"), "keep")
      const preflight = await preflightBatchLinks({ targetHost: "wsl", targetPath: source, linkHost: "wsl", linkPath: destination })
      expect(preflight.ready).toBe(true)
      expect(preflight.items.map((item) => item.name)).toEqual(["occupied", "one"])
      expect(preflight.items.find((item) => item.name === "occupied")?.preflight.ready).toBe(false)
      expect(preflight.items.find((item) => item.name === "one")?.preflight.strategy).toBe("wsl-symlink")
      expect(preflight.items.find((item) => item.name === "one")?.preflight.spec.linkPath).toBe(nodePath.join(destination, "one"))
      await expect(lstat(nodePath.join(destination, "one"))).rejects.toThrow()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it("blocks an existing destination and ordinary directory deletion", async () => {
    const root = await mkdtemp(nodePath.join(tmpdir(), "skills-manager-link-test-"))
    try {
      const target = nodePath.join(root, "source"); const destination = nodePath.join(root, "destination"); const link = nodePath.join(destination, "entry")
      await mkdir(target); await mkdir(destination); await writeFile(link, "do not replace")
      const preflight = await preflightLink({ targetHost: "wsl", targetPath: target, linkHost: "wsl", linkPath: link }); expect(preflight.ready).toBe(false); expect(preflight.risks.join(" ")).toContain("已经存在")
      const deletion = await executeDeleteLink({ host: "wsl", path: destination }); expect(deletion.success).toBe(false); expect(deletion.error).toContain("普通文件和目录")
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

describe("native Windows link scanning", () => {
  it("distinguishes an active Junction from one whose target was deleted in every scan view", async () => {
    const root = await createWindowsTempDirectory()
    try {
      const agentPath = nodePath.join(root.wsl, "agent")
      const activeTargetPath = nodePath.join(root.wsl, "active-target")
      const danglingTargetPath = nodePath.join(root.wsl, "dangling-target")
      const windowsAgentPath = nodePath.win32.join(root.windows, "agent")
      const windowsActiveTargetPath = nodePath.win32.join(root.windows, "active-target")
      const windowsDanglingTargetPath = nodePath.win32.join(root.windows, "dangling-target")
      await mkdir(agentPath, { recursive: true })
      await mkdir(activeTargetPath, { recursive: true })
      await mkdir(danglingTargetPath, { recursive: true })
      await createWindowsJunction(nodePath.win32.join(windowsAgentPath, "active"), windowsActiveTargetPath)
      await createWindowsJunction(nodePath.win32.join(windowsAgentPath, "dangling"), windowsDanglingTargetPath)
      await rm(danglingTargetPath, { recursive: true, force: true })

      const native = await scanWindowsDirectory({ path: windowsAgentPath, recursive: false })
      expect(native.entries).toHaveLength(2)
      expect(native.entries.find((entry) => entry.name === "active")).toMatchObject({ isReparsePoint: true, linkType: "junction", rawTarget: windowsActiveTargetPath, targetPath: windowsActiveTargetPath })
      expect(native.entries.find((entry) => entry.name === "dangling")).toMatchObject({ isReparsePoint: true, linkType: "junction", rawTarget: windowsDanglingTargetPath })
      expect(native.entries.find((entry) => entry.name === "dangling")?.targetPath).toBeUndefined()

      const links = await scanLinkDirectory({ host: "windows", path: windowsAgentPath })
      expect(links.entries).toHaveLength(2)
      expect(links.entries.find((entry) => entry.name === "active")).toMatchObject({ kind: "windows-junction", targetStatus: "exists", targetPath: windowsActiveTargetPath, canDelete: true })
      expect(links.entries.find((entry) => entry.name === "dangling")).toMatchObject({ kind: "windows-junction", targetStatus: "broken", canDelete: true })
      expect(links.entries.find((entry) => entry.name === "dangling")?.targetPath).toBeUndefined()

      const agent = await scanAgent({ id: "windows-agent", name: "Windows Agent", host: "windows", path: windowsAgentPath }, { host: "windows", canonicalPath: root.windows, skills: [] } as never)
      expect(agent.entries).toHaveLength(2)
      expect(agent.entries.find((entry) => entry.name === "active")).toMatchObject({ kind: "repo-link", targetPath: windowsActiveTargetPath })
      expect(agent.entries.find((entry) => entry.name === "dangling")).toMatchObject({ kind: "broken-link" })
      expect(agent.entries.find((entry) => entry.name === "dangling")?.targetPath).toBeUndefined()
    } finally { await rm(root.wsl, { recursive: true, force: true }) }
  })
})

describe("config validation", () => {
  it("requires explicit schema, hosts, and unique agent IDs", () => {
    expect(() => validateConfig({ schemaVersion: 1, vault: { path: "/tmp/vault", host: "wsl" }, agents: [{ id: "a", name: "A", host: "wsl", path: "/tmp/a" }, { id: "a", name: "again", host: "wsl", path: "/tmp/b" }] })).toThrow("duplicate agent id")
    expect(validateConfig({ schemaVersion: 1, vault: { path: "/tmp/vault", host: "wsl" }, agents: [] })).toMatchObject({ schemaVersion: 1 })
  })

  it("keeps a Windows source and WSL mirror as host-local Vaults", () => {
    const loaded = resolveConfig(validateConfig({
      schemaVersion: 1,
      vault: { path: "/tmp/wsl-vault", host: "wsl" },
      agents: [],
      mirrorSync: { source: { path: "C:\\Vault", host: "windows" }, mirror: { path: "/tmp/wsl-vault", host: "wsl" }, scope: "full" },
    }), "/tmp/config.json")
    expect(vaultConfigForHost(loaded, "windows")).toEqual({ path: "C:\\Vault", host: "windows" })
    expect(vaultConfigForHost(loaded, "wsl")).toEqual({ path: "/tmp/wsl-vault", host: "wsl" })
  })

  it("accepts link records, last scan path, and automatic path detection preference", () => {
    const config = validateConfig({
      schemaVersion: 1,
      vault: { path: "/tmp/vault", host: "wsl" },
      agents: [{ id: "a", name: "A", host: "wsl", path: "/tmp/a" }],
      links: [{ skill: "ask-matt", collection: "01_matt-skills", agentId: "a" }],
      lastScanPath: "/home/lee/links",
      autoDetectPathHost: false,
    })
    expect(config.links).toEqual([{ skill: "ask-matt", collection: "01_matt-skills", agentId: "a" }])
    expect(config.lastScanPath).toBe("/home/lee/links")
    expect(config.autoDetectPathHost).toBe(false)
    expect(() => validateConfig({ schemaVersion: 1, vault: { path: "/tmp/vault", host: "wsl" }, agents: [], autoDetectPathHost: "yes" })).toThrow("autoDetectPathHost must be a boolean")
  })
})

describe("Windows-to-WSL mirror sync", () => {
  it("preserves selected source paths, excludes dependencies, and propagates source deletion", async () => {
    const source = await createWindowsTempDirectory()
    const mirror = await mkdtemp(nodePath.join(tmpdir(), "skills-manager-mirror-test-"))
    try {
      await mkdir(nodePath.join(source.wsl, "collection", "skill", "docs"), { recursive: true })
      await writeFile(nodePath.join(source.wsl, "collection", "skill", "SKILL.md"), "source skill")
      await writeFile(nodePath.join(source.wsl, "collection", "skill", "docs", "guide.md"), "source guide")
      await mkdir(nodePath.join(source.wsl, "collection", "skill", "node_modules", "dependency"), { recursive: true })
      await writeFile(nodePath.join(source.wsl, "collection", "skill", "node_modules", "dependency", "index.js"), "source dependency")
      await mkdir(nodePath.join(mirror, "collection", "skill", "node_modules", "dependency"), { recursive: true })
      await writeFile(nodePath.join(mirror, "collection", "skill", "SKILL.md"), "old")
      await writeFile(nodePath.join(mirror, "collection", "skill", "stale.md"), "delete")
      await writeFile(nodePath.join(mirror, "collection", "skill", "node_modules", "dependency", "index.js"), "keep")
      await mkdir(nodePath.join(mirror, "unmanaged"), { recursive: true })
      await writeFile(nodePath.join(mirror, "unmanaged", "keep.md"), "keep")

      const sync = { source: { host: "windows" as const, path: source.windows }, mirror: { host: "wsl" as const, path: mirror }, scope: "selected" as const, selectedPaths: ["collection/skill"] }
      const firstPlan = await planMirrorSync(sync)
      expect(firstPlan.ready).toBe(true)
      expect(firstPlan.operations.map((item) => item.action)).toContain("copy-file")
      expect(firstPlan.operations.some((item) => item.relativePath === "collection/skill/stale.md" && item.action === "delete-file")).toBe(true)
      expect(firstPlan.operations.some((item) => item.relativePath.includes("node_modules"))).toBe(false)
      const firstExecution = await executeMirrorSync(firstPlan)
      expect(firstExecution.results.every((item) => item.success)).toBe(true)
      expect(await readFile(nodePath.join(mirror, "collection", "skill", "SKILL.md"), "utf8")).toBe("source skill")
      expect(await readFile(nodePath.join(mirror, "collection", "skill", "docs", "guide.md"), "utf8")).toBe("source guide")
      await expect(lstat(nodePath.join(mirror, "collection", "skill", "stale.md"))).rejects.toThrow()
      expect(await readFile(nodePath.join(mirror, "collection", "skill", "node_modules", "dependency", "index.js"), "utf8")).toBe("keep")
      expect(await readFile(nodePath.join(mirror, "unmanaged", "keep.md"), "utf8")).toBe("keep")

      await rm(nodePath.join(source.wsl, "collection", "skill", "docs", "guide.md"))
      const deletionPlan = await planMirrorSync(sync)
      expect(deletionPlan.operations.some((item) => item.relativePath === "collection/skill/docs/guide.md" && item.action === "delete-file")).toBe(true)
      await executeMirrorSync(deletionPlan)
      await expect(lstat(nodePath.join(mirror, "collection", "skill", "docs", "guide.md"))).rejects.toThrow()

      const fullPlan = await planMirrorSync({ ...sync, scope: "full", selectedPaths: [] })
      expect(fullPlan.operations.some((item) => item.relativePath === "unmanaged/keep.md" && item.action === "delete-file")).toBe(true)
    } finally {
      await rm(source.wsl, { recursive: true, force: true })
      await rm(mirror, { recursive: true, force: true })
    }
  })
})

describe("convert copy to link", () => {
  it("backs up, links, verifies and removes the backup", async () => {
    const root = await mkdtemp(nodePath.join(tmpdir(), "skills-manager-convert-test-"))
    try {
      await mkdir(nodePath.join(root, "agent", "ask-matt"), { recursive: true })
      await writeFile(nodePath.join(root, "agent", "ask-matt", "note.txt"), "notes")
      await mkdir(nodePath.join(root, "vault", "col", "ask-matt"), { recursive: true })
      await writeFile(nodePath.join(root, "vault", "col", "ask-matt", "SKILL.md"), "---\nname: ask-matt\n---\n")
      const result = await convertCopyToLink({ host: "wsl", agentPath: nodePath.join(root, "agent"), name: "ask-matt", targetPath: nodePath.join(root, "vault", "col", "ask-matt") })
      expect(result).toMatchObject({ attempted: true, success: true })
      const entry = await lstat(nodePath.join(root, "agent", "ask-matt"))
      expect(entry.isSymbolicLink()).toBe(true)
      expect(await readFile(nodePath.join(root, "agent", "ask-matt", "SKILL.md"), "utf8")).toContain("name: ask-matt")
      await expect(lstat(nodePath.join(root, "agent", "ask-matt.__conv__"))).rejects.toThrow()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it("rolls back the original directory when link creation fails", async () => {
    const root = await mkdtemp(nodePath.join(tmpdir(), "skills-manager-convert-test-"))
    try {
      await mkdir(nodePath.join(root, "agent", "ask-matt"), { recursive: true })
      await writeFile(nodePath.join(root, "agent", "ask-matt", "note.txt"), "keep me")
      const result = await convertCopyToLink({ host: "wsl", agentPath: nodePath.join(root, "agent"), name: "ask-matt", targetPath: "/no/such/target" })
      expect(result.success).toBe(false)
      const restored = await lstat(nodePath.join(root, "agent", "ask-matt"))
      expect(restored.isDirectory()).toBe(true)
      expect(await readFile(nodePath.join(root, "agent", "ask-matt", "note.txt"), "utf8")).toBe("keep me")
      await expect(lstat(nodePath.join(root, "agent", "ask-matt.__conv__"))).rejects.toThrow()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

describe("temporary link fixture seam", () => {
  it("scans a broken link without following it", async () => {
    const root = await mkdtemp(nodePath.join(tmpdir(), "skills-manager-test-"))
    try {
      await mkdir(nodePath.join(root, "vault", "one"), { recursive: true }); await writeFile(nodePath.join(root, "vault", "one", "SKILL.md"), "---\nname: one\n---\n")
      await mkdir(nodePath.join(root, "agent"), { recursive: true }); await symlink("missing", nodePath.join(root, "agent", "broken"))
      const vault = await scanVault({ path: nodePath.join(root, "vault"), host: "wsl" }); const agent = await scanAgent({ id: "a", name: "A", host: "wsl", path: nodePath.join(root, "agent") }, vault)
      expect(agent.entries[0]?.kind).toBe("broken-link")
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
