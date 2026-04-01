import { defineCommand } from 'citty'
import { intro, outro, confirm, spinner, cancel, log } from '@clack/prompts'
import { execa } from 'execa'
import pc from 'picocolors'
import { SPINNER_FRAMES } from '../lib/constants.ts'
import { loadRegistry, toolId, allTools, type Registry, type Tool } from '../lib/registry.ts'

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
  const allPkgs = allTools(registry).map((t: Tool) => toolId(t))
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

async function tabSelect(
  message: string,
  groups: Record<string, SelectOption[]>,
  initialValues: string[]
): Promise<string[] | null> {
  const keys = Object.keys(groups)
  const selected = new Set<string>(initialValues)
  let tab = 0
  let cur = 0

  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')

  function draw() {
    process.stdout.write('\x1b[u\x1b[J')

    // Tab bar: emoji only, active inverted
    const bar = keys.map((k, i) => {
      const emoji = k.split(' ')[0]
      return i === tab ? pc.bgCyan(pc.black(` ${emoji} `)) : pc.dim(` ${emoji} `)
    }).join('')
    process.stdout.write('  ' + bar + '\n')

    // Active group name + divider
    const name = keys[tab].split(' ').slice(1).join(' ')
    process.stdout.write('  ' + pc.bold(name) + '\n')
    process.stdout.write('  ' + pc.dim('─'.repeat(48)) + '\n\n')

    // Tools
    for (let i = 0; i < groups[keys[tab]].length; i++) {
      const t = groups[keys[tab]][i]
      const box = selected.has(t.value) ? pc.green('■') : pc.dim('□')
      const ptr = i === cur ? pc.cyan('›') : ' '
      const hint = strip(t.hint ?? '').slice(0, 58)
      process.stdout.write(`  ${ptr} ${box} ${t.label}  ${pc.dim(hint)}\n`)
    }

    process.stdout.write('\n')
    process.stdout.write(pc.dim('  ←/→ tab   ↑/↓ move   space select   enter confirm\n'))
  }

  process.stdout.write(`${pc.cyan('◆')} ${message}\n\n`)
  process.stdout.write('\x1b[?25l\x1b[s')
  draw()

  return new Promise(resolve => {
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')

    const finish = (res: string[] | null) => {
      process.stdin.removeListener('data', onKey)
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdout.write('\x1b[?25h\x1b[u\x1b[J')
      resolve(res)
    }

    const onKey = (key: string) => {
      if (key === '\x03') return finish(null)
      if (key === '\r')   return finish([...selected])

      const tools = groups[keys[tab]]

      if      (key === '\x1b[D' || key === '\x1b[Z') { tab = (tab - 1 + keys.length) % keys.length; cur = 0 }
      else if (key === '\x1b[C' || key === '\t')      { tab = (tab + 1) % keys.length; cur = 0 }
      else if (key === '\x1b[A') { cur = Math.max(0, cur - 1) }
      else if (key === '\x1b[B') { cur = Math.min(tools.length - 1, cur + 1) }
      else if (key === ' ') {
        const v = tools[cur].value
        selected.has(v) ? selected.delete(v) : selected.add(v)
      }

      draw()
    }

    process.stdin.on('data', onKey)
  })
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

    const isUpToDate = (id: string) =>
      status.versions.has(id) && !status.outdated.has(id)

    const toolPriority = (id: string, required = false) => {
      if (required && !status.versions.has(id)) return 0
      if (status.outdated.has(id))              return 1
      if (!status.versions.has(id))             return 2
      return 3
    }

    const toolMap = new Map<string, Tool>()

    // Build grouped options: one entry per category, only non-empty groups
    const groupedOptions: Record<string, SelectOption[]> = {}
    let totalVisible = 0
    let totalHidden  = 0

    for (const [category, group] of Object.entries(registry.packages)) {
      const installable = group.tools.filter(t => t.type || t.installer)
      const options: SelectOption[] = []

      for (const t of installable) {
        const id = toolId(t)
        toolMap.set(id, t)
        if (!args.all && isUpToDate(id)) { totalHidden++; continue }
        options.push({
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
        })
      }

      options.sort((a, b) =>
        toolPriority(a.value, a.required) - toolPriority(b.value, b.required)
      )

      if (options.length > 0) {
        groupedOptions[`${group.emoji} ${category}`] = options
        totalVisible += options.length
      }
    }

    if (totalVisible === 0) {
      outro(pc.green('Everything is up to date. Run with --all to see all tools.'))
      process.exit(0)
    }

    if (!args.all && totalHidden > 0)
      log.info(`${totalHidden} up-to-date tool(s) hidden — run with ${pc.cyan('--all')} to show`)

    const allVisible = Object.values(groupedOptions).flat()

    const outdatedCount = allVisible.filter(t => status.outdated.has(t.value)).length
    if (outdatedCount > 0)
      log.warn(`${outdatedCount} tool(s) have updates available — pre-selected`)

    const preSelected = allVisible
      .filter(t => status.versions.has(t.value) || t.required)
      .map(t => t.value)

    const result = await tabSelect('Select tools to install', groupedOptions, preSelected)

    if (result === null) {
      cancel('Cancelled.')
      process.exit(0)
    }

    const selectedPkgs = result

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
