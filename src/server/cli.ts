import nodePath from "node:path"
import { fileURLToPath } from "node:url"
import {
  buildPlanForAgent,
  buildStatusSnapshot,
  configForWrite,
  createFixtureConfig,
  DEFAULT_CONFIG_PATH,
  initConfig,
  readConfigOrFixture,
  scanWorkspace,
} from "../core/index.ts"

function valueAfter(args: string[], flag: string): string | undefined { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined }
function has(args: string[], flag: string): boolean { return args.includes(flag) }
function json(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`) }
function help(): void { json({ schemaVersion: 1, usage: ["config init --config <file> [--force]", "status --json [--config <file>]", "plan --json [--config <file>] [--agent <id>] [--skills <id,id,...>]"], execution: "preview-only" }) }
async function main(): Promise<void> {
  const args = process.argv.slice(2); const command = args[0]; const configPath = valueAfter(args, "--config") ?? DEFAULT_CONFIG_PATH
  if (!command || command === "--help" || command === "-h") { help(); return }
  if (command === "config" && args[1] === "init") { const created = await initConfig(configPath, has(args, "--force")); json({ schemaVersion: 1, command: "config init", configPath: created.configPath, config: configForWrite(created), execution: "not-run" }); return }
  if (command === "status") { const snapshot = await scanWorkspace(await readConfigOrFixture(configPath)); json(buildStatusSnapshot(snapshot)); return }
  if (command === "plan") {
    const snapshot = await scanWorkspace(await readConfigOrFixture(configPath)); const requestedAgent = valueAfter(args, "--agent") ?? snapshot.config.selectedAgentId ?? snapshot.config.agents[0]?.id; const agent = snapshot.agents.find((item) => item.id === requestedAgent); if (!agent) throw new Error(`agent not found: ${requestedAgent ?? "(none)"}`)
    const rawSkills = valueAfter(args, "--skills"); const selectedSkillIds = rawSkills ? rawSkills.split(",").map((item) => item.trim()).filter(Boolean) : snapshot.vault.skills.filter((skill) => skill.validity === "valid").map((skill) => skill.id); json(buildPlanForAgent({ config: snapshot.config, vault: snapshot.vault, agent, selectedSkillIds })); return
  }
  throw new Error(`unknown command: ${command}`)
}
main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })
