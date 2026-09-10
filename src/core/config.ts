import { constants } from "node:fs"
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import nodePath from "node:path"
import { fileURLToPath } from "node:url"
import { isAbsolutePathForHost } from "./path-host.ts"
import { runtimeHost } from "./host.ts"
import type { AgentConfig, CommonPath, HostKind, LinkRecord, LoadedConfig, MirrorSyncConfig, SkillManagerConfig } from "./types.ts"

export const PROJECT_ROOT = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "../..")
export const DEFAULT_CONFIG_PATH = nodePath.join(PROJECT_ROOT, "data", "config.json")

export function fixturePath(name: string): string {
  return nodePath.join(PROJECT_ROOT, "fixtures", name)
}

export function createFixtureConfig(): SkillManagerConfig {
  return {
    schemaVersion: 1,
    autoDetectPathHost: true,
    vault: { path: fixturePath("vault"), host: "wsl" },
    agents: [{ id: "fixture-agent", name: "Fixture Agent", host: "wsl", path: fixturePath("agents/default") }],
    commonPaths: [],
    links: [],
    selectedAgentId: "fixture-agent",
  }
}

export function createEmptyConfig(host: HostKind = runtimeHost()): SkillManagerConfig {
  return { schemaVersion: 1, autoDetectPathHost: true, vault: { path: "", host }, agents: [] }
}

function nonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string without NUL`)
  }
}

function host(value: unknown, label: string): asserts value is HostKind {
  if (value !== "wsl" && value !== "windows" && value !== "macos") throw new Error(`${label} must be \"wsl\", \"windows\" or \"macos\"`)
}

function validateHostPath(value: string, hostKind: HostKind, label: string): void {
  if (hostKind === "macos" && !isAbsolutePathForHost(hostKind, value)) {
    throw new Error(`${label} must be an absolute macOS path`)
  }
}

function isEmptySetup(value: Partial<SkillManagerConfig>, vaultPath: string): boolean {
  return Boolean(
    typeof value.vault?.path === "string" &&
    vaultPath === "" &&
    value.agents?.length === 0 &&
    (!value.commonPaths || value.commonPaths.length === 0) &&
    (!value.links || value.links.length === 0) &&
    value.mirrorSync === undefined &&
    value.selectedAgentId === undefined,
  )
}

function configuredVaultHost(input: unknown): unknown {
  if (!input || typeof input !== "object" || !("vault" in input)) return undefined
  const vault = input.vault
  if (!vault || typeof vault !== "object" || !("host" in vault)) return undefined
  return vault.host
}

function validateAgent(value: unknown, index: number, ids: Set<string>): AgentConfig {
  if (!value || typeof value !== "object") throw new Error(`agents[${index}] must be an object`)
  const agent = value as Partial<AgentConfig>
  nonEmpty(agent.id, `agents[${index}].id`)
  nonEmpty(agent.name, `agents[${index}].name`)
  nonEmpty(agent.path, `agents[${index}].path`)
  host(agent.host, `agents[${index}].host`)
  validateHostPath(agent.path, agent.host, `agents[${index}].path`)
  const id = agent.id.trim()
  if (ids.has(id)) throw new Error(`duplicate agent id: ${id}`)
  ids.add(id)
  return { id, name: agent.name.trim(), path: agent.path.trim(), host: agent.host }
}

function validateMirrorSync(value: unknown): MirrorSyncConfig {
  if (!value || typeof value !== "object") throw new Error("mirrorSync must be an object")
  const sync = value as Partial<MirrorSyncConfig>
  if (!sync.source || typeof sync.source !== "object") throw new Error("mirrorSync.source is required")
  if (!sync.mirror || typeof sync.mirror !== "object") throw new Error("mirrorSync.mirror is required")
  nonEmpty(sync.source.path, "mirrorSync.source.path")
  nonEmpty(sync.mirror.path, "mirrorSync.mirror.path")
  host(sync.source.host, "mirrorSync.source.host")
  host(sync.mirror.host, "mirrorSync.mirror.host")
  if (sync.source.host === sync.mirror.host) throw new Error("mirrorSync.source.host and mirrorSync.mirror.host must be different")
  if (sync.scope !== "full" && sync.scope !== "selected") throw new Error("mirrorSync.scope must be full or selected")
  if (sync.selectedPaths !== undefined && !Array.isArray(sync.selectedPaths)) throw new Error("mirrorSync.selectedPaths must be an array")
  const selectedPaths = (sync.selectedPaths ?? []).map(function (item, index): string {
    nonEmpty(item, `mirrorSync.selectedPaths[${index}]`)
    return item.trim()
  })
  if (new Set(selectedPaths).size !== selectedPaths.length) throw new Error("mirrorSync.selectedPaths contains duplicates")
  if (sync.exclude !== undefined && !Array.isArray(sync.exclude)) throw new Error("mirrorSync.exclude must be an array")
  const exclude = (sync.exclude ?? []).map(function (item, index): string {
    nonEmpty(item, `mirrorSync.exclude[${index}]`)
    return item.trim()
  })
  return { source: { path: sync.source.path.trim(), host: sync.source.host }, mirror: { path: sync.mirror.path.trim(), host: sync.mirror.host }, scope: sync.scope, ...(selectedPaths.length ? { selectedPaths } : {}), ...(exclude.length ? { exclude } : {}) }
}

function validateCommonPath(value: unknown, index: number, ids: Set<string>): CommonPath {
  if (!value || typeof value !== "object") throw new Error(`commonPaths[${index}] must be an object`)
  const commonPath = value as Partial<CommonPath>
  nonEmpty(commonPath.id, `commonPaths[${index}].id`)
  nonEmpty(commonPath.name, `commonPaths[${index}].name`)
  nonEmpty(commonPath.path, `commonPaths[${index}].path`)
  host(commonPath.host, `commonPaths[${index}].host`)
  validateHostPath(commonPath.path, commonPath.host, `commonPaths[${index}].path`)
  const id = commonPath.id.trim()
  if (ids.has(id)) throw new Error(`duplicate common path id: ${id}`)
  ids.add(id)
  return { id, name: commonPath.name.trim(), host: commonPath.host, path: commonPath.path.trim() }
}

export function validateConfig(input: unknown): SkillManagerConfig {
  if (!input || typeof input !== "object") throw new Error("config must be an object")
  const value = input as Partial<SkillManagerConfig>
  if (value.schemaVersion !== 1) throw new Error("unsupported config schemaVersion; expected 1")
  if (!value.vault || typeof value.vault !== "object") throw new Error("vault is required")
  host(value.vault.host, "vault.host")
  const vaultValue = value.vault
  if (value.autoDetectPathHost !== undefined && typeof value.autoDetectPathHost !== "boolean") throw new Error("autoDetectPathHost must be a boolean")
  if (!Array.isArray(value.agents)) throw new Error("agents must be an array")
  const vaultPath = typeof value.vault.path === "string" ? value.vault.path.trim() : ""
  if (!isEmptySetup(value, vaultPath)) nonEmpty(value.vault.path, "vault.path")
  if (vaultPath) validateHostPath(vaultPath, vaultValue.host, "vault.path")

  const agentIds = new Set<string>()
  const agents = value.agents.map(function (item: unknown, index: number): AgentConfig {
    return validateAgent(item, index, agentIds)
  })
  const commonIds = new Set<string>()
  const commonPaths = Array.isArray(value.commonPaths)
    ? value.commonPaths.map(function (item: unknown, index: number): CommonPath { return validateCommonPath(item, index, commonIds) })
    : []

  const links = Array.isArray(value.links)
    ? value.links.map(function (item: unknown, index: number): LinkRecord {
        if (!item || typeof item !== "object") throw new Error(`links[${index}] must be an object`)
        const record = item as Partial<LinkRecord>
        nonEmpty(record.skill, `links[${index}].skill`)
        nonEmpty(record.agentId, `links[${index}].agentId`)
        if (typeof record.collection !== "string") throw new Error(`links[${index}].collection must be a string`)
        return { skill: record.skill.trim(), collection: record.collection, agentId: record.agentId.trim() }
      })
    : []

  const mirrorSync = value.mirrorSync === undefined ? undefined : validateMirrorSync(value.mirrorSync)
  if (mirrorSync) {
    if (mirrorSync.source.host === "macos" || mirrorSync.mirror.host === "macos") throw new Error("mirrorSync does not support macos")
    const expectedEntry = [
      ["source", mirrorSync.source] as const,
      ["mirror", mirrorSync.mirror] as const,
    ].find(function (item): boolean { return item[1].host === vaultValue.host })
    if (!expectedEntry) throw new Error(`mirrorSync has no Vault for the selected Host: ${vaultValue.host}`)
    const normalize = vaultValue.host === "windows" ? nodePath.win32.normalize : nodePath.posix.normalize
    const baselinePath = normalize(vaultValue.path.trim())
    const expectedPath = normalize(expectedEntry[1].path)
    const samePath = vaultValue.host === "windows"
      ? baselinePath.toLocaleLowerCase("en-US") === expectedPath.toLocaleLowerCase("en-US")
      : baselinePath === expectedPath
    if (!samePath) throw new Error(`vault.path must match mirrorSync.${expectedEntry[0]}.path for the selected Host`)
  }

  let lastScanPath: string | undefined
  if (value.lastScanPath !== undefined) {
    if (typeof value.lastScanPath !== "string") throw new Error("lastScanPath must be a string")
    lastScanPath = value.lastScanPath.trim() || undefined
  }

  let selectedAgentId: string | undefined
  if (value.selectedAgentId !== undefined) {
    nonEmpty(value.selectedAgentId, "selectedAgentId")
    selectedAgentId = value.selectedAgentId.trim()
    if (!agentIds.has(selectedAgentId)) throw new Error(`selectedAgentId is not configured: ${selectedAgentId}`)
  }
  return {
    schemaVersion: 1,
    ...(value.autoDetectPathHost !== undefined ? { autoDetectPathHost: value.autoDetectPathHost } : {}),
    vault: { path: value.vault.path.trim(), host: value.vault.host },
    agents,
    commonPaths,
    links,
    ...(mirrorSync ? { mirrorSync } : {}),
    ...(lastScanPath ? { lastScanPath } : {}),
    ...(selectedAgentId ? { selectedAgentId } : {}),
  }
}

function resolvePath(value: string, hostKind: HostKind, directory: string): string {
  if (!value.trim()) return ""
  return isAbsolutePathForHost(hostKind, value) ? value : nodePath.resolve(directory, value)
}

export function resolveConfig(input: SkillManagerConfig, configPath: string, exists = true): LoadedConfig {
  const validated = validateConfig(input)
  const absolute = nodePath.resolve(configPath)
  const directory = nodePath.dirname(absolute)
  return {
    ...validated,
    exists,
    configPath: absolute,
    vault: { ...validated.vault, path: resolvePath(validated.vault.path, validated.vault.host, directory) },
    agents: validated.agents.map(function (agent): AgentConfig {
      return { ...agent, path: resolvePath(agent.path, agent.host, directory) }
    }),
    ...(validated.mirrorSync ? {
      mirrorSync: {
        ...validated.mirrorSync,
        source: { ...validated.mirrorSync.source, path: resolvePath(validated.mirrorSync.source.path, validated.mirrorSync.source.host, directory) },
        mirror: { ...validated.mirrorSync.mirror, path: resolvePath(validated.mirrorSync.mirror.path, validated.mirrorSync.mirror.host, directory) },
      },
    } : {}),
  }
}

export async function configExists(path = DEFAULT_CONFIG_PATH): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function readConfig(configPath = DEFAULT_CONFIG_PATH): Promise<LoadedConfig> {
  const absolute = nodePath.resolve(configPath)
  const raw = JSON.parse(await readFile(absolute, "utf8")) as unknown
  return resolveConfig(validateConfig(raw), absolute, true)
}

export async function readConfigOrFixture(configPath = DEFAULT_CONFIG_PATH, expectedHost: HostKind = runtimeHost()): Promise<LoadedConfig> {
  if (await configExists(configPath)) {
    if (expectedHost === "macos") {
      const raw = JSON.parse(await readFile(nodePath.resolve(configPath), "utf8")) as unknown
      if (configuredVaultHost(raw) !== "macos") return resolveConfig(createEmptyConfig("macos"), configPath, false)
    }
    return readConfig(configPath)
  }
  return resolveConfig(expectedHost === "macos" ? createEmptyConfig("macos") : createFixtureConfig(), configPath, false)
}

export async function writeConfig(configPath: string, config: SkillManagerConfig): Promise<LoadedConfig> {
  const absolute = nodePath.resolve(configPath)
  const validated = validateConfig(config)
  await mkdir(nodePath.dirname(absolute), { recursive: true })
  const temp = `${absolute}.tmp-${process.pid}`
  await writeFile(temp, `${JSON.stringify(validated, null, 2)}\n`, "utf8")
  await rename(temp, absolute)
  return resolveConfig(validated, absolute, true)
}

export async function initConfig(configPath: string, force = false): Promise<LoadedConfig> {
  const absolute = nodePath.resolve(configPath)
  if (!force && await configExists(absolute)) throw new Error(`config already exists: ${absolute}; use --force to replace it`)
  return writeConfig(absolute, runtimeHost() === "macos" ? createEmptyConfig("macos") : createFixtureConfig())
}

export function configForWrite(config: LoadedConfig): SkillManagerConfig {
  return {
    schemaVersion: 1,
    ...(config.autoDetectPathHost !== undefined ? { autoDetectPathHost: config.autoDetectPathHost } : {}),
    vault: { ...config.vault },
    agents: config.agents.map(function (agent): AgentConfig { return { ...agent } }),
    commonPaths: (config.commonPaths ?? []).map(function (item): CommonPath { return { ...item } }),
    links: (config.links ?? []).map(function (item): LinkRecord { return { ...item } }),
    ...(config.mirrorSync ? { mirrorSync: { ...config.mirrorSync, source: { ...config.mirrorSync.source }, mirror: { ...config.mirrorSync.mirror }, ...(config.mirrorSync.selectedPaths ? { selectedPaths: [...config.mirrorSync.selectedPaths] } : {}), ...(config.mirrorSync.exclude ? { exclude: [...config.mirrorSync.exclude] } : {}) } } : {}),
    ...(config.lastScanPath ? { lastScanPath: config.lastScanPath } : {}),
    ...(config.selectedAgentId ? { selectedAgentId: config.selectedAgentId } : {}),
  }
}
