import { defineCommand } from 'citty'
import { intro, outro, multiselect, confirm, spinner, cancel, log } from '@clack/prompts'
import { execa } from 'execa'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { parse } from 'yaml'
import pc from 'picocolors'

const __dirname = dirname(fileURLToPath(import.meta.url))

const SPINNER_FRAMES = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷']

interface Tool {
  name: string
  description: string
  brew: string
  type?: 'formula' | 'cask'
}

interface Registry {
  categories: Record<string, Tool[]>
}

interface VersionInfo {
  current: string
  latest: string
}

interface PackageStatus {
  versions: Map<string, string>
  outdated: Map<string, VersionInfo>
}

interface SelectOption {
  value: string
  label: string
  hint: string
  type: 'formula' | 'cask'
}

function loadRegistry(): Registry {
  const filePath = resolve(__dirname, '../../tools/macos.yaml')
  return parse(readFileSync(filePath, 'utf8')) as Registry
}

async function getPackageStatus(): Promise<PackageStatus> {
  const [infoResult, outdatedResult] = await Promise.allSettled([
    execa('brew', ['info', '--json=v2', '--installed']),
    execa('brew', ['outdated', '--json=v2']),
  ])

  const versions = new Map<string, string>()

  if (infoResult.status === 'fulfilled') {
    const data = JSON.parse(infoResult.value.stdout)

    for (const formula of data.formulae ?? []) {
      const version = formula.installed?.[0]?.version
      if (formula.name && version) versions.set(formula.name, version)
    }

    for (const cask of data.casks ?? []) {
      const version = cask.installed
      if (cask.token && version) versions.set(cask.token, version)
    }
  }

  const outdated = new Map<string, VersionInfo>()

  if (outdatedResult.status === 'fulfilled') {
    const data = JSON.parse(outdatedResult.value.stdout)

    for (const formula of data.formulae ?? []) {
      outdated.set(formula.name, {
        current: formula.installed_versions?.[0] ?? '',
        latest:  formula.current_version ?? '',
      })
    }

    for (const cask of data.casks ?? []) {
      outdated.set(cask.name, {
        current: cask.installed_versions?.[0] ?? '',
        latest:  cask.current_version ?? '',
      })
    }
  }

  return { versions, outdated }
}

function buildSummary(registry: Registry, status: PackageStatus): string {
  const allPkgs = Object.values(registry.categories).flat().map(t => t.brew)
  const installedCount = allPkgs.filter(p => status.versions.has(p)).length
  const outdatedCount  = allPkgs.filter(p => status.outdated.has(p)).length
  const newCount       = allPkgs.filter(p => !status.versions.has(p)).length

  return (
    `${pc.green(`${installedCount} installed`)}  ` +
    `${pc.yellow(`${outdatedCount} outdated`)}  ` +
    `${pc.dim(`${newCount} new`)}`
  )
}

function buildHint(
  pkg: string,
  category: string,
  description: string,
  status: PackageStatus
): string {
  const versionInfo = status.outdated.get(pkg)
  if (versionInfo)
    return pc.yellow(`↑ ${versionInfo.current} → ${versionInfo.latest}`)

  const installedVersion = status.versions.get(pkg)
  if (installedVersion)
    return pc.green(`✓ v${installedVersion}`)

  return pc.dim(`${category} · ${description}`)
}

function brewInstall(pkg: string, type: 'formula' | 'cask' = 'formula') {
  return type === 'cask'
    ? execa('brew', ['install', '--cask', pkg])
    : execa('brew', ['install', pkg])
}

function brewUpgrade(pkg: string, type: 'formula' | 'cask' = 'formula') {
  return type === 'cask'
    ? execa('brew', ['upgrade', '--cask', pkg])
    : execa('brew', ['upgrade', pkg])
}

export default defineCommand({
  meta: { description: 'Install tools from the registry' },
  async run() {
    intro(pc.bgCyan(pc.black(' rig install ')))

    const s = spinner({ frames: SPINNER_FRAMES })
    s.start('Checking package status...')
    const registry = loadRegistry()
    const status = await getPackageStatus()
    s.stop(buildSummary(registry, status))

    const allTools: SelectOption[] = Object.entries(registry.categories).flatMap(
      ([category, tools]) =>
        tools.map(t => ({
          value: t.brew,
          label: status.outdated.has(t.brew)
            ? pc.yellow(t.name)
            : status.versions.has(t.brew)
              ? pc.green(t.name)
              : t.name,
          hint: buildHint(t.brew, category, t.description, status),
          type: t.type ?? 'formula',
        }))
    )

    const preSelected = allTools
      .filter(t => status.versions.has(t.value))
      .map(t => t.value)

    const outdatedInRegistry = allTools.filter(t => status.outdated.has(t.value))
    if (outdatedInRegistry.length > 0)
      log.warn(`${outdatedInRegistry.length} tool(s) have updates available — pre-selected`)

    const selected = await multiselect({
      message: 'Select tools to install',
      options: allTools,
      initialValues: preSelected,
      required: true,
    })

    if (typeof selected === 'symbol') {
      cancel('Cancelled.')
      process.exit(0)
    }

    const selectedPkgs = selected as string[]
    const toolMap = new Map(allTools.map(t => [t.value, t]))

    const toInstall = selectedPkgs.filter(p => !status.versions.has(p))
    const toUpgrade = selectedPkgs.filter(p => status.outdated.has(p))

    if (toInstall.length === 0 && toUpgrade.length === 0) {
      outro(pc.green('Everything is up to date.'))
      process.exit(0)
    }

    if (toInstall.length > 0)
      log.info(`New:     ${toInstall.map(p => pc.cyan(p)).join(', ')}`)
    if (toUpgrade.length > 0)
      log.warn(`Upgrade: ${toUpgrade.map(p => pc.yellow(p)).join(', ')}`)

    const confirmed = await confirm({
      message: `Proceed with ${toInstall.length} install(s) and ${toUpgrade.length} upgrade(s)?`,
    })

    if (!confirmed || typeof confirmed === 'symbol') {
      cancel('Cancelled.')
      process.exit(0)
    }

    const sp = spinner({ frames: SPINNER_FRAMES })

    for (const pkg of toInstall) {
      const type = toolMap.get(pkg)?.type ?? 'formula'
      sp.start(`Installing ${pc.cyan(pkg)}...`)
      try {
        await brewInstall(pkg, type)
        sp.stop(`${pc.green('✓')} ${pkg}`)
      } catch {
        sp.stop(`${pc.red('✗')} ${pkg} — failed`)
      }
    }

    for (const pkg of toUpgrade) {
      const type = toolMap.get(pkg)?.type ?? 'formula'
      sp.start(`Upgrading ${pc.yellow(pkg)}...`)
      try {
        await brewUpgrade(pkg, type)
        sp.stop(`${pc.green('✓')} ${pkg} upgraded`)
      } catch {
        sp.stop(`${pc.red('✗')} ${pkg} — failed`)
      }
    }

    outro(pc.green('Done.'))
  },
})