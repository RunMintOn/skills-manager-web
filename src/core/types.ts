export type HostKind = "wsl" | "windows"
export type ScanSeverity = "warning" | "error"
export type VaultSkillValidity = "valid" | "invalid"

export type AgentEntryKind =
  | "repo-link"
  | "repo-copy"
  | "local-dir"
  | "external-link"
  | "broken-link"
  | "invalid"

export type ComparisonState =
  | "linked"
  | "pending"
  | "local-dir"
  | "external-link"
  | "broken-link"
  | "invalid"

export interface VaultConfig { path: string; host: HostKind }
export interface AgentConfig { id: string; name: string; host: HostKind; path: string }
export interface SkillManagerConfig {
  schemaVersion: 1
  vault: VaultConfig
  agents: AgentConfig[]
  selectedAgentId?: string
}
export interface LoadedConfig extends SkillManagerConfig { configPath: string; exists: boolean }

export interface Frontmatter {
  present: boolean
  raw: string
  fields: Record<string, string>
  name?: string
  description?: string
  errors: string[]
}

export type SkillIssueCode =
  | "frontmatter-missing"
  | "frontmatter-malformed"
  | "name-missing"
  | "name-mismatch"
  | "duplicate-id"
  | "skill-read-error"

export interface SkillIssue { code: SkillIssueCode; severity: ScanSeverity; message: string }
export interface VaultSkill {
  id: string
  relativePath: string
  absolutePath: string
  canonicalPath?: string
  collection: string
  directoryName: string
  frontmatter: Frontmatter
  name?: string
  description?: string
  validity: VaultSkillValidity
  issues: SkillIssue[]
}
export interface VaultValidationIssue {
  code: SkillIssueCode | "vault-missing" | "vault-unreadable"
  severity: ScanSeverity
  relativePath?: string
  skillId?: string
  message: string
}
export interface VaultCollection {
  id: string
  label: string
  skillIds: string[]
  validCount: number
  invalidCount: number
}
export interface VaultScanSummary {
  total: number
  valid: number
  invalid: number
  collections: number
  duplicateIds: number
  issueCount: number
}
export interface VaultScan {
  path: string
  host: HostKind
  supported: boolean
  rootExists: boolean
  canonicalPath?: string
  skills: VaultSkill[]
  collections: VaultCollection[]
  duplicateIds: string[]
  issues: VaultValidationIssue[]
  summary: VaultScanSummary
}

export type AgentEntryIssueCode =
  | "agent-root-missing"
  | "agent-root-unreadable"
  | "local-directory"
  | "external-link"
  | "broken-link"
  | "invalid-entry"
  | "cross-host-link"
  | "duplicate-skill-entry"
  | "invalid-skill-metadata"
export interface AgentEntryIssue { code: AgentEntryIssueCode; severity: ScanSeverity; message: string }
export interface AgentEntry {
  name: string
  relativePath: string
  absolutePath: string
  kind: AgentEntryKind
  targetPath?: string
  targetVaultRelativePath?: string
  skillId?: string
  frontmatter?: Frontmatter
  issues: AgentEntryIssue[]
}
export interface AgentScanSummary {
  total: number
  repoLinks: number
  repoCopies: number
  localDirs: number
  externalLinks: number
  brokenLinks: number
  invalid: number
  issueCount: number
}
export interface AgentScan {
  id: string
  name: string
  path: string
  host: HostKind
  supported: boolean
  rootExists: boolean
  canonicalPath?: string
  entries: AgentEntry[]
  issues: AgentEntryIssue[]
  summary: AgentScanSummary
}

export interface ComparisonRow {
  skillId: string
  skillPath: string
  collection: string
  state: ComparisonState
  agentEntryPaths: string[]
  risks: string[]
}
export interface ComparisonResult {
  agentId: string
  rows: ComparisonRow[]
  actualOnly: AgentEntry[]
  summary: Record<ComparisonState, number>
  actualSummary: { "local-dir": number; "external-link": number; "broken-link": number; invalid: number }
  issueCount: number
}

export interface WslCommandOperation {
  kind: "wsl-command"
  host: "wsl"
  executable: "wsl.exe"
  args: string[]
  shell: false
  targetPath: string
  linkPath: string
  directoryOnly: true
}
export interface WindowsJunctionOperation {
  kind: "windows-junction"
  host: "windows"
  api: "fs.promises.symlink"
  fsArgs: [targetPath: string, linkPath: string, type: "junction"]
  targetPath: string
  linkPath: string
  directoryOnly: true
}
export type LinkOperationPlan = WslCommandOperation | WindowsJunctionOperation
export type PlanAction = "create-link" | "already-linked" | "blocked"
export interface SyncPlanOperation {
  id: string
  skillId: string
  skillPath?: string
  agentId: string
  action: PlanAction
  targetPath?: string
  linkPath?: string
  link?: LinkOperationPlan
  risks: string[]
  execution: "not-run"
}
export interface SyncPlan {
  schemaVersion: 1
  mode: "preview-only"
  agentId: string
  selectedSkillIds: string[]
  unknownSkillIds: string[]
  operations: SyncPlanOperation[]
  safety: {
    filesystemWrites: "disabled"
    shell: "never"
    windowsExecution: "manual-only"
    note: string
  }
}

export interface WorkspaceSnapshot { config: LoadedConfig; vault: VaultScan; agents: AgentScan[] }
export interface StatusSnapshot {
  schemaVersion: 1
  tool: "skill-manager-web"
  execution: "preview-only"
  config: { path: string; exists: boolean; selectedAgentId?: string; agentCount: number }
  vault: VaultScan
  agents: AgentScan[]
  selectedAgentId?: string
  comparison?: ComparisonResult
  safety: { vault: "read-only"; agents: "read-only-scan"; sync: "preview-only" }
}
