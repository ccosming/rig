import { defineCommand } from 'citty'
import { intro, outro, multiselect, confirm, spinner, cancel, log } from '@clack/prompts'
import { execa } from 'execa'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { parse } from 'yaml'
import pc from 'picocolors'

const __dirname = dirname(fileURLToPath(import.meta.url))

interface Tool {
  name: string
  description: string
  brew: string
}

interface Registry {
  categories: Record<string, Tool[]>
}

interface VersionInfo {
  current: string
  latest: string
}

interface PackageStatus {
  versions: Map<string, string>        // pkg → installed version
  outdated: Map<string, VersionInfo>   // pkg → { current, latest }
}

function loadRegistry(): Registry {
  const filePath = resolve(__dirname, '../../tools/macos.yaml')
  return parse(readFileSync(filePath, 'utf8')) as Registry
}

async function getPackageStatus(): Promise<PackageStatus> {
  const [versionsResult, outdatedResult] = await Promise.allSettled([
    execa('brew', ['list', '--formula', '--versions']),
    execa('brew', ['outdated', '--verbose']),
  ])

  // "neovim 0.10.0\nripgrep 14.1.0"
  const versions = new Map<string, string>()
  if (versionsResult.status === 'fulfilled') {
    for (const line of versionsResult.value.stdout.split('\n').filter(Boolean)) {
      const [pkg, version] = line.trim().split(/\s+/)
      if (pkg && version) versions.set(pkg, version)
    }
  }

  // "neovim (0.9.4) < 0.10.0"
  const outdated = new Map<string, VersionInfo>()
  if (outdatedResult.status === 'fulfilled') {
    for (const line of outdatedResult.value.stdout.split('\n').filter(Boolean)) {
      const match = line.match(/^(\S+)\s+\((.+?)\)\s+<\s+(.+)$/)
      if (match) outdated.set(match[1], { current: match[2], latest: match[3] })
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

export default defineCommand({
  meta: { description: 'Install tools from the registry' },
  async run() {
    intro(pc.bgCyan(pc.black(' rig install ')))

    const s = spinner()
    s.start('Checking package status...')
    const registry = loadRegistry()
    const status = await getPackageStatus()
    s.stop(buildSummary(registry, status))

    const allTools = Object.entries(registry.categories).flatMap(
      ([category, tools]) =>
        tools.map(t => ({
          value: t.brew,
          label: status.outdated.has(t.brew)
            ? pc.yellow(t.name)
            : status.versions.has(t.brew)
              ? pc.green(t.name)
              : t.name,
          hint: buildHint(t.brew, category, t.description, status),
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

    const toInstall = (selected as string[]).filter(p => !status.versions.has(p))
    const toUpgrade = (selected as string[]).filter(p => status.outdated.has(p))

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

    const sp = spinner()

    for (const pkg of toInstall) {
      sp.start(`Installing ${pc.cyan(pkg)}...`)
      try {
        await execa('brew', ['install', pkg])
        sp.stop(`${pc.green('✓')} ${pkg}`)
      } catch {
        sp.stop(`${pc.red('✗')} ${pkg} — failed`)
      }
    }

    for (const pkg of toUpgrade) {
      sp.start(`Upgrading ${pc.yellow(pkg)}...`)
      try {
        await execa('brew', ['upgrade', pkg])
        sp.stop(`${pc.green('✓')} ${pkg} upgraded`)
      } catch {
        sp.stop(`${pc.red('✗')} ${pkg} — failed`)
      }
    }

    outro(pc.green('Done.'))
  },
})