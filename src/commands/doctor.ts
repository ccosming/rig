import { defineCommand } from 'citty'
import { intro, outro, log, spinner, confirm, cancel } from '@clack/prompts'
import { execa } from 'execa'
import pc from 'picocolors'
import { SPINNER_FRAMES, RIG_DIR } from '../lib/constants.ts'
import { loadRegistry, allTools, isCore, isManaged, hasSystemFiles } from '../lib/registry.ts'
import { resolve } from 'path'
import { homedir } from 'os'

const DOTFILES_DIR = resolve(RIG_DIR, 'dotfiles')

type ToolType = 'core' | 'managed' | 'required'

interface CheckResult {
  name: string
  toolType: ToolType
  ok: boolean
  version?: string
  dotfiles?: boolean      // only relevant for managed tools
  pending?: boolean       // dotfiles exist but drift detected vs system
  systemFiles?: boolean   // source files exist on system
  brew?: string
  brewType?: 'formula' | 'cask'
}

function parseVersion(raw: string): string {
  const match = raw.match(/\d+\.\d+[\.\d]*/)
  return match ? match[0] : raw
}

async function checkCommand(cmd: string, args: string[] = ['--version']): Promise<string | null> {
  try {
    const { stdout } = await execa(cmd, args)
    return stdout.split('\n')[0].trim()
  } catch {
    return null
  }
}

const CORE_FIX: Record<string, string> = {
  homebrew: '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
  git:      'xcode-select --install',
  proto:    'brew install proto',
  node:     'proto install node',
  chezmoi:  'brew install chezmoi',
}

async function getPendingFiles(): Promise<Set<string>> {
  try {
    const { stdout } = await execa('chezmoi', ['-S', DOTFILES_DIR, 'status'])
    return new Set(
      stdout.trim().split('\n').filter(Boolean)
        .map(line => resolve(homedir(), line.slice(2)))
    )
  } catch {
    return new Set()
  }
}

async function runChecks(registry: ReturnType<typeof loadRegistry>): Promise<CheckResult[]> {
  const tools = allTools(registry)

  const coreTools = [
    { name: 'homebrew', cmd: 'brew',    args: ['--version'] },
    { name: 'git',      cmd: 'git',     args: ['--version'] },
    { name: 'proto',    cmd: 'proto',   args: ['--version'] },
    { name: 'node',     cmd: 'node',    args: ['--version'] },
    { name: 'chezmoi',  cmd: 'chezmoi', args: ['--version'] },
  ]

  const trackedTools = tools.filter(t => (t.required || isManaged(t)) && !isCore(t))

  const [protoStatus, pendingFiles, managedFiles] = await Promise.all([
    execa('proto', ['status', '-c', 'global', '--json'])
      .then(r => JSON.parse(r.stdout) as Record<string, any>)
      .catch(() => ({} as Record<string, any>)),
    getPendingFiles(),
    execa('chezmoi', ['-S', DOTFILES_DIR, 'managed', '--path-style', 'absolute'])
      .then(r => new Set(r.stdout.trim().split('\n').filter(Boolean)))
      .catch(() => new Set<string>()),
  ])

  const [coreResults, toolResults] = await Promise.all([
    Promise.all(
      coreTools.map(async ({ name, cmd, args }): Promise<CheckResult> => {
        const raw = await checkCommand(cmd, args)
        return { name, toolType: 'core', ok: raw !== null, version: raw ? parseVersion(raw) : undefined }
      })
    ),
    Promise.all(
      trackedTools.map(async (tool): Promise<CheckResult> => {
        const toolType: ToolType = isManaged(tool) ? 'managed' : 'required'
        const dotfiles    = isManaged(tool)
          ? tool.sync!.files.some(f => {
              const abs = f.source.startsWith('~/') ? resolve(homedir(), f.source.slice(2)) : f.source
              return managedFiles.has(abs)
            })
          : undefined
        const systemFiles = isManaged(tool) ? hasSystemFiles(tool) : undefined
        const pending     = dotfiles
          ? tool.sync!.files.some(f => {
              const abs = f.source.startsWith('~/') ? resolve(homedir(), f.source.slice(2)) : f.source
              return pendingFiles.has(abs)
            })
          : undefined

        if (tool.installer === 'proto') {
          const info = protoStatus[tool.name]
          if (info?.is_installed)
            return { name: tool.name, toolType, ok: true, version: parseVersion(info.resolved_version), dotfiles, pending, systemFiles }
          return { name: tool.name, toolType, ok: false, dotfiles, pending, systemFiles, brew: tool.name, brewType: tool.type }
        }

        try {
          const { stdout } = await execa('brew', ['info', '--json=v2', tool.name])
          const data = JSON.parse(stdout)
          const entry = tool.type === 'cask' ? data.casks?.[0] : data.formulae?.[0]
          const installed = tool.type === 'cask' ? entry?.installed : entry?.installed?.[0]?.version
          if (!installed)
            return { name: tool.name, toolType, ok: false, dotfiles, pending, systemFiles, brew: tool.name, brewType: tool.type }
          return { name: tool.name, toolType, ok: true, version: parseVersion(installed), dotfiles, pending, systemFiles }
        } catch {
          return { name: tool.name, toolType, ok: false, dotfiles, pending, systemFiles, brew: tool.name, brewType: tool.type }
        }
      })
    ),
  ])

  return [...coreResults, ...toolResults]
}

function printTable(results: CheckResult[]) {
  const priority = (r: CheckResult) => {
    if (!r.ok)                                                         return 0  // not installed
    if (r.toolType === 'managed' && !r.dotfiles && !r.systemFiles)     return 1  // configure tool first
    if (r.toolType === 'managed' && !r.dotfiles && r.systemFiles)      return 2  // pending (new)
    if (r.toolType === 'managed' && r.dotfiles && r.pending)           return 2  // outdated (drift)
    return 3                                                                      // ok
  }

  const sorted = [...results].sort((a, b) => priority(a) - priority(b))

  const colName    = Math.max(...sorted.map(r => r.name.length), 'tool'.length) + 2
  const colType    = 'required'.length + 2
  const colVersion = Math.max(...sorted.map(r => (r.version ?? '—').length), 'version'.length) + 2

  const rowColor = (r: CheckResult) => {
    if (!r.ok)                                                     return pc.red
    if (r.toolType === 'managed' && !r.dotfiles && r.systemFiles)  return pc.yellow
    if (r.toolType === 'managed' && r.dotfiles && r.pending)       return pc.yellow
    if (r.toolType === 'managed' && !r.dotfiles && !r.systemFiles) return pc.red
    return pc.green
  }

  const statusText = (r: CheckResult): string => {
    if (!r.ok)                                                     return 'not installed'
    if (r.toolType === 'managed' && r.dotfiles && r.pending)       return 'outdated'
    if (r.toolType === 'managed' && !r.dotfiles && r.systemFiles)  return 'pending'
    if (r.toolType === 'managed' && !r.dotfiles && !r.systemFiles) return 'configure tool first'
    return 'ok'
  }

  const header = pc.dim(
    `  ${'tool'.padEnd(colName)}${'type'.padEnd(colType)}${'version'.padEnd(colVersion)}status`
  )

  const rows = sorted.map(r => {
    const color   = rowColor(r)
    const name    = color(r.name.padEnd(colName))
    const type    = color(r.toolType.padEnd(colType))
    const version = color((r.version ?? '—').padEnd(colVersion))
    const status  = color(statusText(r))
    return `  ${name}${type}${version}${status}`
  })

  log.message([header, ...rows].join('\n'))
}

export default defineCommand({
  meta: { description: 'Verify environment health' },
  async run() {
    intro(pc.bgCyan(pc.black(' rig doctor ')))

    const registry = loadRegistry()
    const s = spinner({ frames: SPINNER_FRAMES })
    s.start('Running checks...')
    const results = await runChecks(registry)
    s.stop('Done')

    printTable(results)

    const notInstalled = results.filter(r => !r.ok)
    const failed       = results.filter(r => !r.ok || (r.toolType === 'managed' && !r.dotfiles && !r.systemFiles))
    const syncPending  = results.filter(r => r.toolType === 'managed' && r.ok && r.dotfiles && r.pending)
    const addDotfiles  = results.filter(r => r.toolType === 'managed' && r.ok && !r.dotfiles && r.systemFiles)
    const needsConfig  = results.filter(r => r.toolType === 'managed' && r.ok && !r.dotfiles && !r.systemFiles)
    const allOk        = failed.length === 0 && syncPending.length === 0 && addDotfiles.length === 0 && needsConfig.length === 0

    if (syncPending.length > 0)
      log.warn(`${syncPending.length} tool(s) have pending changes — run ${pc.cyan('rig sync')} to update dotfiles`)
    if (addDotfiles.length > 0)
      log.warn(`${addDotfiles.length} tool(s) not yet tracked — run ${pc.cyan('rig sync')} to add to dotfiles`)
    if (needsConfig.length > 0)
      log.warn(`${needsConfig.length} tool(s) not yet configured — set them up first, then run ${pc.cyan('rig sync')}`)

    if (allOk) {
      outro(pc.green('All checks passed.'))
      return
    }

    const coreFailed   = results.filter(r => r.toolType === 'core' && !r.ok)
    const fixableTools = results.filter(r => r.toolType !== 'core' && !r.ok && r.brew)

    if (coreFailed.length > 0) {
      log.warn(`${coreFailed.length} core check(s) failed — fix manually:`)
      const fixes = coreFailed.map(r => {
        const fix = CORE_FIX[r.name.toLowerCase()]
        return `  ${pc.dim('→')} ${pc.cyan(r.name)}: ${fix ? pc.dim(fix) : 'check your system installation'}`
      })
      log.message(fixes.join('\n'))
    }

    const hasWarnings = syncPending.length > 0 || addDotfiles.length > 0 || needsConfig.length > 0

    if (fixableTools.length === 0) {
      const parts: string[] = []
      if (notInstalled.length > 0) parts.push(`${notInstalled.length} not installed`)
      if (needsConfig.length > 0)  parts.push(`${needsConfig.length} need configuration`)
      if (hasWarnings && parts.length === 0) parts.push('warnings require attention')
      outro(pc.yellow(parts.join(', ') + '.'))
      return
    }

    const shouldFix = await confirm({ message: `Fix ${fixableTools.length} missing tool(s) now?` })

    if (typeof shouldFix === 'symbol' || !shouldFix) {
      cancel('')
      log.info(`Run ${pc.cyan('rig install')} to install missing tools`)
      process.exit(0)
    }

    const sp = spinner({ frames: SPINNER_FRAMES })

    for (const tool of fixableTools) {
      sp.start(`Installing ${pc.cyan(tool.name)}...`)
      try {
        const args = tool.brewType === 'cask' ? ['install', '--cask', tool.brew!] : ['install', tool.brew!]
        await execa('brew', args)
        sp.stop(`${pc.green('✓')} ${tool.name} installed`)
      } catch {
        sp.stop(`${pc.red('✗')} ${tool.name} — failed`)
      }
    }

    outro(pc.green('Done.'))
  },
})
