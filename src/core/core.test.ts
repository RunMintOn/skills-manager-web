import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import nodePath from "node:path"
import {
  appendSafeChild,
  buildComparison,
  buildPlanForAgent,
  createFixtureConfig,
  createLinkOperation,
  getHostPathAdapter,
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
    expect(parseFrontmatter("# no block").errors).toContain("frontmatter-missing")
  })

  it("rejects traversal and shell-shaped path segments while preserving Unicode", () => {
    expect(isSafeWslPath("/tmp/a b/$(echo nope)" )).toBe(true)
    expect(isSafeWslPath("/tmp/../escape")).toBe(false)
    expect(() => appendSafeChild(getHostPathAdapter("wsl"), "/tmp/agent", "中文 skill")).not.toThrow()
    expect(() => appendSafeChild(getHostPathAdapter("wsl"), "/tmp/agent", "../escape")).toThrow()
    expect(() => createLinkOperation({ vaultHost: "windows", agentHost: "wsl", targetPath: "C:\\\\Vault\\skill", linkPath: "/tmp/skill" })).toThrow()
  })
})

describe("fixture Vault and Agent scans", () => {
  it("finds nested Collections, Loose Skills, invalid metadata and duplicate IDs", async () => {
    const vault = await scanVault({ path: fixturePath("vault"), host: "wsl" })
    expect(vault.rootExists).toBe(true)
    expect(vault.summary).toMatchObject({ total: 7, valid: 3, invalid: 4, duplicateIds: 1 })
    expect(vault.collections.map((item) => item.label)).toEqual(["Loose Skills", "duplicates", "engineering", "invalid", "operations"])
    expect(vault.skills.find((skill) => skill.id === "unicode-helper")?.collection).toBe("Loose Skills")
    expect(vault.skills.find((skill) => skill.id === "lint-helper")?.relativePath).toBe("engineering/tools/lint-helper")
    expect(vault.duplicateIds).toEqual(["duplicate-skill"])
    expect(vault.skills.find((skill) => skill.directoryName === "broken-demo")?.validity).toBe("invalid")
  })

  it("keeps all six Agent entry categories distinct", async () => {
    const vault = await scanVault({ path: fixturePath("vault"), host: "wsl" })
    const agent = await scanAgent({ id: "fixture-agent", name: "Fixture Agent", host: "wsl", path: fixturePath("agents/default") }, vault)
    expect(agent.summary).toMatchObject({ total: 7, repoLinks: 1, repoCopies: 1, localDirs: 1, externalLinks: 1, brokenLinks: 1, invalid: 2 })
    expect(new Set(agent.entries.map((entry) => entry.kind))).toEqual(new Set(["repo-link", "repo-copy", "local-dir", "external-link", "broken-link", "invalid"]))
    expect(agent.entries.find((entry) => entry.name === "code-review")?.skillId).toBe("code-review")
    expect(agent.entries.find((entry) => entry.name === "lint-helper-copy")?.kind).toBe("repo-copy")
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

describe("config validation", () => {
  it("requires explicit schema, hosts, and unique agent IDs", () => {
    expect(() => validateConfig({ schemaVersion: 1, vault: { path: "/tmp/vault", host: "wsl" }, agents: [{ id: "a", name: "A", host: "wsl", path: "/tmp/a" }, { id: "a", name: "again", host: "wsl", path: "/tmp/b" }] })).toThrow("duplicate agent id")
    expect(validateConfig({ schemaVersion: 1, vault: { path: "/tmp/vault", host: "wsl" }, agents: [] })).toMatchObject({ schemaVersion: 1 })
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
