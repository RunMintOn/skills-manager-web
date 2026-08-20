import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import nodePath from "node:path"
import {
  appendSafeChild,
  buildComparison,
  buildPlanForAgent,
  convertCopyToLink,
  createFixtureConfig,
  createLinkOperation,
  executeDeleteLink,
  executeLink,
  getHostPathAdapter,
  preflightLink,
  scanLinkDirectory,
  isSafeWslPath,
  parseFrontmatter,
  scanAgent,
  scanVault,
  toggleSelection,
  validateConfig,
} from "./index.ts"
import { fixturePath } from "./config.ts"

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
    expect(agent.entries.find((entry) => entry.name === "code-review")?.skillId).toBe("code-review")
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
    expect(comparison.rows.find((row) => row.skillId === "unicode-helper")?.state).toBe("pending")
  })

  it("produces typed, not-run operations and never mutates the filesystem", async () => {
    const vault = await scanVault({ path: fixturePath("vault"), host: "wsl" })
    const config = createFixtureConfig(); const agent = await scanAgent(config.agents[0]!, vault)
    const before = await readFile(nodePath.join(fixturePath("agents/default"), "local-notes/README.md"), "utf8")
    const plan = buildPlanForAgent({ config, vault, agent, selectedSkillIds: ["unicode-helper", "code-review", "lint-helper", "missing-id"] })
    expect(plan.mode).toBe("preview-only"); expect(plan.safety.filesystemWrites).toBe("disabled")
    expect(plan.operations.map((item) => item.action)).toEqual(["already-linked", "blocked", "blocked", "create-link"])
    const create = plan.operations.find((item) => item.skillId === "unicode-helper")!
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

describe("config validation", () => {
  it("requires explicit schema, hosts, and unique agent IDs", () => {
    expect(() => validateConfig({ schemaVersion: 1, vault: { path: "/tmp/vault", host: "wsl" }, agents: [{ id: "a", name: "A", host: "wsl", path: "/tmp/a" }, { id: "a", name: "again", host: "wsl", path: "/tmp/b" }] })).toThrow("duplicate agent id")
    expect(validateConfig({ schemaVersion: 1, vault: { path: "/tmp/vault", host: "wsl" }, agents: [] })).toMatchObject({ schemaVersion: 1 })
  })

  it("accepts link records and last scan path", () => {
    const config = validateConfig({
      schemaVersion: 1,
      vault: { path: "/tmp/vault", host: "wsl" },
      agents: [{ id: "a", name: "A", host: "wsl", path: "/tmp/a" }],
      links: [{ skill: "ask-matt", collection: "01_matt-skills", agentId: "a" }],
      lastScanPath: "/home/lee/links",
    })
    expect(config.links).toEqual([{ skill: "ask-matt", collection: "01_matt-skills", agentId: "a" }])
    expect(config.lastScanPath).toBe("/home/lee/links")
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
