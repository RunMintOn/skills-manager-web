import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import nodePath from "node:path"
import {
  createEmptyConfig,
  createMacosDefaultConfig,
  configForWrite,
  detectPathHost,
  getHostPathAdapter,
  isAbsolutePathForHost,
  readConfigOrFixture,
  resolveConfig,
  scanVault,
  validateConfig,
} from "./index.ts"

describe("macOS runtime configuration", () => {
  it("uses macos for native POSIX paths", () => {
    expect(getHostPathAdapter("macos").supportedRuntime).toBe(true)
    expect(detectPathHost("/Users/lee/Skills", "macos")).toBe("macos")
    expect(isAbsolutePathForHost("macos", "/Users/lee/Skills")).toBe(true)
    expect(isAbsolutePathForHost("macos", "Skills")).toBe(false)
  })

  it("accepts an empty first-run macOS configuration", () => {
    const config = createEmptyConfig("macos")
    expect(validateConfig(config)).toMatchObject({
      vault: { path: "", host: "macos" },
      agents: [],
    })
  })

  it("requires absolute paths for configured macOS Vaults and Agents", () => {
    expect(() => validateConfig({
      schemaVersion: 1,
      vault: { path: "vault", host: "macos" },
      agents: [],
    })).toThrow("vault.path must be an absolute macOS path")

    expect(validateConfig({
      schemaVersion: 1,
      vault: { path: "/Users/lee/Vault", host: "macos" },
      agents: [{ id: "agent", name: "Agent", path: "/Users/lee/Agent", host: "macos" }],
    })).toMatchObject({ vault: { host: "macos" }, agents: [{ host: "macos" }] })

    expect(validateConfig({
      schemaVersion: 1,
      vault: { path: "/Users/lee/Vault", host: "macos" },
      agents: [{ id: "codex", name: "Codex", path: "$HOME/.codex/skills", host: "macos" }],
    })).toMatchObject({ agents: [{ path: "$HOME/.codex/skills" }] })
  })

  it("provides portable built-in Mac Agent paths", () => {
    const config = createMacosDefaultConfig()
    expect(config.agents.map((agent) => agent.path)).toEqual([
      "$HOME/.codex/skills",
      "$HOME/.pi/agent/skills",
      "$HOME/.agents/skills",
    ])

    const loaded = resolveConfig(config, "/tmp/config.json", false)
    expect(loaded.agents.map((agent) => agent.path)).toEqual([
      nodePath.join(homedir(), ".codex/skills"),
      nodePath.join(homedir(), ".pi/agent/skills"),
      nodePath.join(homedir(), ".agents/skills"),
    ])
    expect(configForWrite(loaded).agents.map((agent) => agent.path)).toEqual(config.agents.map((agent) => agent.path))
  })

  it("returns Mac defaults without loading fixtures when no config exists", async () => {
    const root = await mkdtemp(nodePath.join(tmpdir(), "skills-manager-macos-config-"))
    try {
      const loaded = await readConfigOrFixture(nodePath.join(root, "config.json"), "macos")
      expect(loaded.exists).toBe(false)
      expect(loaded.vault).toEqual({ path: "", host: "macos" })
      expect(loaded.agents.map((agent) => agent.path)).toEqual([
        nodePath.join(homedir(), ".codex/skills"),
        nodePath.join(homedir(), ".pi/agent/skills"),
        nodePath.join(homedir(), ".agents/skills"),
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("does not import a legacy WSL config on macOS", async () => {
    const root = await mkdtemp(nodePath.join(tmpdir(), "skills-manager-macos-legacy-"))
    try {
      const configPath = nodePath.join(root, "config.json")
      await writeFile(configPath, JSON.stringify({
        schemaVersion: 1,
        vault: { path: "/old/wsl/vault", host: "wsl" },
        agents: [{ id: "old", name: "Old", path: "/old/wsl/agent", host: "wsl" }],
      }))
      const loaded = await readConfigOrFixture(configPath, "macos")
      expect(loaded.exists).toBe(false)
      expect(loaded.vault).toEqual({ path: "", host: "macos" })
      expect(loaded.agents).toHaveLength(3)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("does not scan the process directory for an empty Vault path", async () => {
    const vault = await scanVault({ path: "", host: "macos" })
    expect(vault.rootExists).toBe(false)
    expect(vault.skills).toEqual([])
    expect(vault.summary.total).toBe(0)
  })
})
