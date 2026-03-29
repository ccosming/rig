import { defineCommand } from 'citty'
import { intro, outro, multiselect, confirm, spinner, cancel, log } from '@clack/prompts'
import { execa } from 'execa'
import pc from 'picocolors'
import { SPINNER_FRAMES } from '../lib/constants.ts'
import { loadRegistry, toolId, type Registry, type Tool, type PackageGroup } from '../lib/registry.ts'

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
  required: boolean
}

async function getPackageStatus(): Promise<PackageStatus> {
  const [infoResult, outdatedResult, protoStatusResult, protoOutdatedResult] = await Promise.allSettled([
    execa('brew', ['info', '--json=v2', '--installed']),
    execa('brew', ['outdated', '--json=v2']),
    execa('proto', ['status', '-c', 'global', '--json']),
    execa('proto', ['outdated', '-c', 'global', '--json']),
  ])

  const versions = new Map<string, string>()

  if (infoResult.status === 'fulfilled') {
    const data = JSON.parse(infoResult.value.stdout)

    for (const formula of data.formulae ?? []) {
      const version = formula.installed?.[0]?.version
      if (formula.name && version) versions.set(formula.name, version)
    }

    for (const cask of data.casks ?? []) {
      const version = cask.installed?.split(',')[0]
      if (cask.token && version) versions.set(cask.token, version)
    }
  }

  if (protoStatusResult.status === 'fulfilled') {
    const data = JSON.parse(protoStatusResult.value.stdout)
    for (const [name, info] of Object.entries(data) as [string, any][]) {
      if (info.is_installed) versions.set(name, info.resolved_version)
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
        current: cask.installed_versions?.[0]?.split(',')[0] ?? '',
        latest:  cask.current_version?.split(',')[0] ?? '',
      })
    }
  }

  if (protoOutdatedResult.status === 'fulfilled') {
    const data = JSON.parse(protoOutdatedResult.value.stdout)
    for (const [name, info] of Object.entries(data) as [string, any][]) {
      const pinned = info.current_version ?? ''
      const latest = info.newest_version ?? ''
      if (info.is_outdated && pinned !== latest) {
        outdated.set(name, { current: pinned, latest })
      }
    }
  }

  return { versions, outdated }
}

function buildSummary(registry: Registry, status: PackageStatus): string {
  const allPkgs = Object.values(registry.packages).flatMap((g: PackageGroup) => g.tools).map((t: Tool) => toolId(t))
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
  emoji: string,
  description: string,
  status: PackageStatus,
  required = false
): string {
  const versionInfo = status.outdated.get(pkg)
  if (versionInfo)
    return pc.yellow(`↑ update available  ${versionInfo.current} → ${versionInfo.latest}`) + pc.dim(`  ·  ${emoji} ${category} · ${description}`)

  const installedVersion = status.versions.get(pkg)
  if (installedVersion)
    return pc.green(`✓ v${installedVersion}`)

  const badge = required ? pc.magenta('★ required') + ' · ' : ''
  return badge + pc.dim(`${emoji} ${category} · ${description}`)
}


function installTool(t: Tool) {
  if (t.installer === 'proto') {
    const args = ['pin', t.name, '--global']
    if (t.version) args.splice(2, 0, t.version)
    return execa('proto', args)
  }
  return t.type === 'cask'
    ? execa('brew', ['install', '--cask', t.name])
    : execa('brew', ['install', t.name])
}

function upgradeTool(t: Tool) {
  if (t.installer === 'proto') {
    const args = ['pin', t.name, '--global']
    if (t.version) args.splice(2, 0, t.version)
    return execa('proto', args)
  }
  return t.type === 'cask'
    ? execa('brew', ['upgrade', '--cask', t.name])
    : execa('brew', ['upgrade', t.name])
}

export default defineCommand({
  meta: { description: 'Install tools from the registry' },
  args: {
    all: {
      type: 'boolean',
      description: 'Show all tools including already installed',
      default: false,
    },
  },
  async run({ args }) {
    intro(pc.bgCyan(pc.black(' rig install ')))

    const s = spinner({ frames: SPINNER_FRAMES })
    s.start('Checking package status...')
    const registry = loadRegistry()
    const status = await getPackageStatus()
    s.stop(buildSummary(registry, status))

    const rawTools: { option: SelectOption, tool: Tool }[] = Object.entries(registry.packages).flatMap(
      ([category, group]) =>
        group.tools.map(t => {
          const id = toolId(t)
          return {
            tool: t,
            option: {
              value: id,
              label: status.outdated.has(id)
                ? pc.yellow(t.name.toLowerCase())
                : status.versions.has(id)
                  ? pc.green(t.name.toLowerCase())
                  : t.required
                    ? pc.magenta(t.name.toLowerCase())
                    : t.name.toLowerCase(),
              hint: buildHint(id, category, group.emoji, t.description, status, t.required),
              type: t.type ?? 'formula',
              required: t.required ?? false,
            },
          }
        })
    )

    const allTools = rawTools.map(r => r.option)
    const toolMap  = new Map(rawTools.map(r => [r.option.value, r.tool]))

    const isUpToDate = (t: SelectOption) =>
      status.versions.has(t.value) && !status.outdated.has(t.value)

    const toolPriority = (t: SelectOption) => {
      if (t.required && !status.versions.has(t.value)) return 0
      if (status.outdated.has(t.value))                return 1
      if (!status.versions.has(t.value))               return 2
      return 3
    }
    allTools.sort((a, b) => toolPriority(a) - toolPriority(b))

    const visibleTools = args.all
      ? allTools
      : allTools.filter(t => !isUpToDate(t))

    if (visibleTools.length === 0) {
      outro(pc.green('Everything is up to date. Run with --all to see all tools.'))
      process.exit(0)
    }

    if (!args.all) {
      const hiddenCount = allTools.length - visibleTools.length
      if (hiddenCount > 0)
        log.info(`${hiddenCount} up-to-date tool(s) hidden — run with ${pc.cyan('--all')} to show`)
    }

    const preSelected = visibleTools
      .filter(t => status.versions.has(t.value) || t.required)
      .map(t => t.value)

    const outdatedInRegistry = visibleTools.filter(t => status.outdated.has(t.value))
    if (outdatedInRegistry.length > 0)
      log.warn(`${outdatedInRegistry.length} tool(s) have updates available — pre-selected`)

    const selected = await multiselect({
      message: 'Select tools to install',
      options: visibleTools,
      initialValues: preSelected,
      required: true,
    })

    if (typeof selected === 'symbol') {
      cancel('Cancelled.')
      process.exit(0)
    }

    const selectedPkgs = selected as string[]

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
      const tool = toolMap.get(pkg)!
      sp.start(`Installing ${pc.cyan(pkg)}...`)
      try {
        await installTool(tool)
        sp.stop(`${pc.green('✓')} ${pkg}`)
      } catch {
        sp.stop(`${pc.red('✗')} ${pkg} — failed`)
      }
    }

    for (const pkg of toUpgrade) {
      const tool = toolMap.get(pkg)!
      sp.start(`Upgrading ${pc.yellow(pkg)}...`)
      try {
        await upgradeTool(tool)
        sp.stop(`${pc.green('✓')} ${pkg} upgraded`)
      } catch {
        sp.stop(`${pc.red('✗')} ${pkg} — failed`)
      }
    }

    outro(pc.green('Done.'))
  },
})
