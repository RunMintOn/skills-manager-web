import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import nodePath from "node:path"
import { fileURLToPath } from "node:url"
import type { AgentConfig, HostKind, LoadedConfig, SkillManagerConfig } from "./types.js"

export const PROJECT_ROOT = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "../..")
export const DEFAULT_CONFIG_PATH = nodePath.join(PROJECT_ROOT, "data", "config.json")
export function fixturePath(name: string): string { return nodePath.join(PROJECT_ROOT, "fixtures", name) }
export function createFixtureConfig(): SkillManagerConfig {
  return { schemaVersion: 1, vault: { path: fixturePath("vault"), host: "wsl" }, agents: [{ id: "fixture-agent", name: "Fixture Agent", host: "wsl", path: fixturePath("agents/default") }], selectedAgentId: "fixture-agent" }
}
function nonEmpty(value: unknown, label: string): asserts value is string { if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(`${label} must be a non-empty string without NUL`) }
function host(value: unknown, label: string): asserts value is HostKind { if (value !== "wsl" && value !== "windows") throw new Error(`${label} must be \"wsl\" or \"windows\"`) }
export function validateConfig(input: unknown): SkillManagerConfig {
  if (!input || typeof input !== "object") throw new Error("config must be an object")
  const value = input as Partial<SkillManagerConfig>
  if (value.schemaVersion !== 1) throw new Error("unsupported config schemaVersion; expected 1")
  if (!value.vault || typeof value.vault !== "object") throw new Error("vault is required")
  nonEmpty(value.vault.path, "vault.path"); host(value.vault.host, "vault.host")
  if (!Array.isArray(value.agents)) throw new Error("agents must be an array")
  const ids = new Set<string>()
  const agents = value.agents.map((item, index): AgentConfig => {
    if (!item || typeof item !== "object") throw new Error(`agents[${index}] must be an object`)
    nonEmpty(item.id, `agents[${index}].id`); nonEmpty(item.name, `agents[${index}].name`); nonEmpty(item.path, `agents[${index}].path`); host(item.host, `agents[${index}].host`)
    const id = item.id.trim(); if (ids.has(id)) throw new Error(`duplicate agent id: ${id}`); ids.add(id)
    return { id, name: item.name.trim(), path: item.path.trim(), host: item.host }
  })
  let selectedAgentId: string | undefined
  if (value.selectedAgentId !== undefined) { nonEmpty(value.selectedAgentId, "selectedAgentId"); selectedAgentId = value.selectedAgentId.trim(); if (!ids.has(selectedAgentId)) throw new Error(`selectedAgentId is not configured: ${selectedAgentId}`) }
  return { schemaVersion: 1, vault: { path: value.vault.path.trim(), host: value.vault.host }, agents, ...(selectedAgentId ? { selectedAgentId } : {}) }
}
function resolvePath(value: string, hostKind: HostKind, directory: string): string {
  const absolute = hostKind === "windows" ? /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\") : value.startsWith("/")
  return absolute ? value : nodePath.resolve(directory, value)
}
export function resolveConfig(input: SkillManagerConfig, configPath: string, exists = true): LoadedConfig {
  const validated = validateConfig(input); const absolute = nodePath.resolve(configPath); const directory = nodePath.dirname(absolute)
  return { ...validated, exists, configPath: absolute, vault: { ...validated.vault, path: resolvePath(validated.vault.path, validated.vault.host, directory) }, agents: validated.agents.map((agent) => ({ ...agent, path: resolvePath(agent.path, agent.host, directory) })) }
}
export async function configExists(path = DEFAULT_CONFIG_PATH): Promise<boolean> { try { await access(path, constants.F_OK); return true } catch { return false } }
export async function readConfig(configPath = DEFAULT_CONFIG_PATH): Promise<LoadedConfig> { const absolute = nodePath.resolve(configPath); const raw = JSON.parse(await readFile(absolute, "utf8")) as unknown; return resolveConfig(validateConfig(raw), absolute, true) }
export async function readConfigOrFixture(configPath = DEFAULT_CONFIG_PATH): Promise<LoadedConfig> { return await configExists(configPath) ? readConfig(configPath) : resolveConfig(createFixtureConfig(), configPath, false) }
export async function writeConfig(configPath: string, config: SkillManagerConfig): Promise<LoadedConfig> { const absolute = nodePath.resolve(configPath); const validated = validateConfig(config); await mkdir(nodePath.dirname(absolute), { recursive: true }); const temp = `${absolute}.tmp-${process.pid}`; await writeFile(temp, `${JSON.stringify(validated, null, 2)}\n`, "utf8"); await rename(temp, absolute); return resolveConfig(validated, absolute, true) }
export function configForWrite(config: LoadedConfig): SkillManagerConfig { return { schemaVersion: 1, vault: { ...config.vault }, agents: config.agents.map((agent) => ({ ...agent })), ...(config.selectedAgentId ? { selectedAgentId: config.selectedAgentId } : {}) } }
