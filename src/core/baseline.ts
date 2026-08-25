import type { HostKind, SkillManagerConfig, VaultConfig } from "./types.ts"

/** Returns the mirror side that represents the selected baseline host. */
export function mirrorVaultForHost(config: SkillManagerConfig, hostKind: HostKind): VaultConfig | undefined {
  if (!config.mirrorSync) return config.vault.host === hostKind ? { ...config.vault } : undefined
  const matchingSide = [config.mirrorSync.source, config.mirrorSync.mirror].find(function (side): boolean { return side.host === hostKind })
  return matchingSide ? { ...matchingSide } : undefined
}

/** Keeps the active baseline path and its matching mirror side in one state transition. */
export function synchronizeBaselineWithMirror(config: SkillManagerConfig, vault: VaultConfig): SkillManagerConfig {
  const mirrorSync = config.mirrorSync
  if (!mirrorSync) return { ...config, vault: { ...vault } }
  const side = mirrorSync.source.host === vault.host ? "source" : mirrorSync.mirror.host === vault.host ? "mirror" : undefined
  if (!side) throw new Error(`没有找到 Host 为 ${vault.host} 的镜像 Vault`)
  return {
    ...config,
    vault: { ...vault },
    mirrorSync: {
      ...mirrorSync,
      [side]: { ...mirrorSync[side], path: vault.path, host: vault.host },
    },
  }
}
