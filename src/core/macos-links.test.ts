import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import nodePath from "node:path"
import {
  buildPlanForAgent,
  executeDeleteLink,
  executeLink,
  preflightBatchLinks,
  preflightLink,
  scanAgent,
  scanLinkDirectory,
  scanVault,
} from "./index.ts"

describe("macOS Skill workspace", () => {
  it("scans a Mac Vault and plans a native Skill symlink", async () => {
    const root = await mkdtemp(nodePath.join(tmpdir(), "skills-manager-macos-skill-"))
    try {
      const vaultPath = nodePath.join(root, "vault")
      const agentPath = nodePath.join(root, "agent")
      const skillPath = nodePath.join(vaultPath, "engineering", "lint-helper")
      await mkdir(skillPath, { recursive: true })
      await mkdir(agentPath)
      await writeFile(nodePath.join(skillPath, "SKILL.md"), "---\nname: lint-helper\ndescription: lint\n---\n")

      const vault = await scanVault({ path: vaultPath, host: "macos" })
      const agent = await scanAgent({ id: "mac-agent", name: "Mac Agent", host: "macos", path: agentPath }, vault)
      const plan = buildPlanForAgent({
        config: { schemaVersion: 1, vault: { path: vaultPath, host: "macos" }, agents: [{ id: "mac-agent", name: "Mac Agent", host: "macos", path: agentPath }] },
        vault,
        agent,
        selectedSkillIds: ["engineering/lint-helper"],
      })

      expect(vault.summary).toMatchObject({ total: 1, valid: 1 })
      expect(agent.rootExists).toBe(true)
      expect(plan.operations[0]).toMatchObject({ action: "create-link", skillKey: "engineering/lint-helper", link: { kind: "macos-symlink", host: "macos" } })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("creates, scans and deletes a Mac directory symlink without deleting its target", async () => {
    const root = await mkdtemp(nodePath.join(tmpdir(), "skills-manager-macos-directory-link-"))
    try {
      const target = nodePath.join(root, "target")
      const linkDirectory = nodePath.join(root, "links")
      const link = nodePath.join(linkDirectory, "target")
      await mkdir(target)
      await mkdir(linkDirectory)
      await writeFile(nodePath.join(target, "keep.txt"), "keep")
      const spec = { targetHost: "macos" as const, targetPath: target, linkHost: "macos" as const, linkPath: link }

      expect((await preflightLink(spec)).ready).toBe(true)
      expect((await executeLink(spec)).success).toBe(true)
      expect(await lstat(link)).toMatchObject({ isSymbolicLink: expect.any(Function) })
      expect((await scanLinkDirectory({ host: "macos", path: linkDirectory })).entries[0]).toMatchObject({ kind: "macos-symlink", targetStatus: "exists", canDelete: true })
      const nestedTarget = nodePath.join(root, "nested-target")
      const nestedLinkDirectory = nodePath.join(linkDirectory, "nested")
      const nestedLink = nodePath.join(nestedLinkDirectory, "nested-target")
      await mkdir(nestedTarget)
      await mkdir(nestedLinkDirectory)
      expect((await executeLink({ targetHost: "macos", targetPath: nestedTarget, linkHost: "macos", linkPath: nestedLink })).success).toBe(true)
      expect((await scanLinkDirectory({ host: "macos", path: linkDirectory, recursive: true })).entries.some((entry) => entry.relativePath === "nested/nested-target")).toBe(true)
      expect((await executeDeleteLink({ host: "macos", path: link })).success).toBe(true)
      await expect(lstat(link)).rejects.toThrow()
      await expect(readFile(nodePath.join(target, "keep.txt"), "utf8")).resolves.toBe("keep")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("creates and removes a Mac file symlink", async () => {
    const root = await mkdtemp(nodePath.join(tmpdir(), "skills-manager-macos-file-link-"))
    try {
      const target = nodePath.join(root, "目标 空格", "source $file.txt")
      const link = nodePath.join(root, "链接 空格 $file.txt")
      await mkdir(nodePath.dirname(target), { recursive: true })
      await writeFile(target, "keep")
      const spec = { targetHost: "macos" as const, targetPath: target, linkHost: "macos" as const, linkPath: link }

      expect((await preflightLink(spec)).strategy).toBe("macos-symlink")
      expect((await executeLink(spec)).success).toBe(true)
      expect(await readFile(link, "utf8")).toBe("keep")
      expect((await executeDeleteLink({ host: "macos", path: link })).success).toBe(true)
      expect(await readFile(target, "utf8")).toBe("keep")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("preflights direct Mac Skill children as flat native links", async () => {
    const root = await mkdtemp(nodePath.join(tmpdir(), "skills-manager-macos-batch-link-"))
    try {
      const source = nodePath.join(root, "source")
      const destination = nodePath.join(root, "destination")
      await mkdir(nodePath.join(source, "one"), { recursive: true })
      await mkdir(nodePath.join(source, "nested", "two"), { recursive: true })
      await mkdir(destination)
      await writeFile(nodePath.join(source, "one", "SKILL.md"), "---\nname: one\n---\n")
      await writeFile(nodePath.join(source, "nested", "two", "SKILL.md"), "---\nname: two\n---\n")

      const preflight = await preflightBatchLinks({ targetHost: "macos", targetPath: source, linkHost: "macos", linkPath: destination })
      expect(preflight.ready).toBe(true)
      expect(preflight.items.map((item) => item.name)).toEqual(["one"])
      expect(preflight.items[0]?.preflight).toMatchObject({ ready: true, strategy: "macos-symlink" })
      const created = await executeLink(preflight.items[0]!.preflight.spec)
      expect(created).toMatchObject({ success: true, strategy: "macos-symlink" })
      expect((await scanLinkDirectory({ host: "macos", path: destination })).entries[0]).toMatchObject({ name: "one", kind: "macos-symlink", targetStatus: "exists" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
