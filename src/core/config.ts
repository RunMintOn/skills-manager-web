import { constants } from "node:fs"
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import nodePath from "node:path"
import { fileURLToPath } from "node:url"
import type { AgentConfig, CommonPath, HostKind, LoadedConfig, SkillManagerConfig } from "./types.ts"

export const PROJECT_ROOT = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "../..")
export const DEFAULT_CONFIG_PATH = nodePath.join(PROJECT_ROOT, "data", "config.json")

export function fixturePath(name: string): string {
  return nodePath.join(PROJECT_ROOT, "fixtures", name)
}

export function createFixtureConfig(): SkillManagerConfig {
  return {
    schemaVersion: 1,
    vault: { path: fixturePath("vault"), host: "wsl" },
    agents: [{ id: "fixture-agent", name: "Fixture Agent", host: "wsl", path: fixturePath("agents/default") }],
    commonPaths: [],
    selectedAgentId: "fixture-agent",
  }
}

function nonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string without NUL`)
  }
}

function host(value: unknown, label: string): asserts value is HostKind {
  if (value !== "wsl" && value !== "windows") throw new Error(`${label} must be \"wsl\" or \"windows\"`)
}

function validateAgent(value: unknown, index: number, ids: Set<string>): AgentConfig {
  if (!value || typeof value !== "object") throw new Error(`agents[${index}] must be an object`)
  const agent = value as Partial<AgentConfig>
  nonEmpty(agent.id, `agents[${index}].id`)
  nonEmpty(agent.name, `agents[${index}].name`)
  nonEmpty(agent.path, `agents[${index}].path`)
  host(agent.host, `agents[${index}].host`)
  const id = agent.id.trim()
  if (ids.has(id)) throw new Error(`duplicate agent id: ${id}`)
  ids.add(id)
  return { id, name: agent.name.trim(), path: agent.path.trim(), host: agent.host }
}

function validateCommonPath(value: unknown, index: number, ids: Set<string>): CommonPath {
  if (!value || typeof value !== "object") throw new Error(`commonPaths[${index}] must be an object`)
  const commonPath = value as Partial<CommonPath>
  nonEmpty(commonPath.id, `commonPaths[${index}].id`)
  nonEmpty(commonPath.name, `commonPaths[${index}].name`)
  nonEmpty(commonPath.path, `commonPaths[${index}].path`)
  host(commonPath.host, `commonPaths[${index}].host`)
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
  nonEmpty(value.vault.path, "vault.path")
  host(value.vault.host, "vault.host")
  if (!Array.isArray(value.agents)) throw new Error("agents must be an array")

  const agentIds = new Set<string>()
  const agents = value.agents.map(function (item: unknown, index: number): AgentConfig {
    return validateAgent(item, index, agentIds)
  })
  const commonIds = new Set<string>()
  const commonPaths = Array.isArray(value.commonPaths)
    ? value.commonPaths.map(function (item: unknown, index: number): CommonPath { return validateCommonPath(item, index, commonIds) })
    : []

  let selectedAgentId: string | undefined
  if (value.selectedAgentId !== undefined) {
    nonEmpty(value.selectedAgentId, "selectedAgentId")
    selectedAgentId = value.selectedAgentId.trim()
    if (!agentIds.has(selectedAgentId)) throw new Error(`selectedAgentId is not configured: ${selectedAgentId}`)
  }
  return {
    schemaVersion: 1,
    vault: { path: value.vault.path.trim(), host: value.vault.host },
    agents,
    commonPaths,
    ...(selectedAgentId ? { selectedAgentId } : {}),
  }
}

function resolvePath(value: string, hostKind: HostKind, directory: string): string {
  const absolute = hostKind === "windows"
    ? /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\")
    : value.startsWith("/")
  return absolute ? value : nodePath.resolve(directory, value)
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

export async function readConfigOrFixture(configPath = DEFAULT_CONFIG_PATH): Promise<LoadedConfig> {
  if (await configExists(configPath)) return readConfig(configPath)
  return resolveConfig(createFixtureConfig(), configPath, false)
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
  return writeConfig(absolute, createFixtureConfig())
}

export function configForWrite(config: LoadedConfig): SkillManagerConfig {
  return {
    schemaVersion: 1,
    vault: { ...config.vault },
    agents: config.agents.map(function (agent): AgentConfig { return { ...agent } }),
    commonPaths: (config.commonPaths ?? []).map(function (item): CommonPath { return { ...item } }),
    ...(config.selectedAgentId ? { selectedAgentId: config.selectedAgentId } : {}),
  }
}
