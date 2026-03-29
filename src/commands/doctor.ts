import { defineCommand } from 'citty'
import { intro, outro, log, spinner, confirm, cancel } from '@clack/prompts'
import { execa } from 'execa'
import pc from 'picocolors'
import { SPINNER_FRAMES } from '../lib/constants.ts'
import { loadRegistry, type Tool, type PackageGroup } from '../lib/registry.ts'

interface CheckResult {
  name: string
  ok: boolean
  version?: string
  hint?: string
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
}

async function runChecks(): Promise<{ core: CheckResult[], tools: CheckResult[] }> {
  const registry = loadRegistry()

  const coreNames = new Set(['homebrew', 'git', 'proto', 'node'])

  const requiredTools = Object.values(registry.packages)
    .flatMap((g: PackageGroup) => g.tools)
    .filter((t: Tool) => t.required && !coreNames.has(t.name.toLowerCase()))

  const coreChecks: Array<{ name: string, cmd: string, args?: string[] }> = [
    { name: 'Homebrew', cmd: 'brew',  args: ['--version'] },
    { name: 'git',      cmd: 'git',   args: ['--version'] },
    { name: 'proto',    cmd: 'proto', args: ['--version'] },
    { name: 'node',     cmd: 'node',  args: ['--version'] },
  ]

  const protoStatus = await execa('proto', ['status', '-c', 'global', '--json'])
    .then(r => JSON.parse(r.stdout) as Record<string, any>)
    .catch(() => ({} as Record<string, any>))

  const [coreResults, toolResults] = await Promise.all([
    Promise.all(
      coreChecks.map(async ({ name, cmd, args }): Promise<CheckResult> => {
        const version = await checkCommand(cmd, args)
        return {
          name,
          ok: version !== null,
          version: version ? parseVersion(version) : undefined,
        }
      })
    ),
    Promise.all(
      requiredTools.map(async (tool): Promise<CheckResult> => {
        if (tool.installer === 'proto') {
          const info = protoStatus[tool.name]
          if (info?.is_installed) {
            return { name: tool.name, ok: true, version: parseVersion(info.resolved_version) }
          }
          return { name: tool.name, ok: false, hint: 'not installed', brew: tool.name, brewType: tool.type }
        }

        try {
          const { stdout } = await execa('brew', ['info', '--json=v2', tool.name])
          const data = JSON.parse(stdout)

          const entry = tool.type === 'cask'
            ? data.casks?.[0]
            : data.formulae?.[0]

          const installed = tool.type === 'cask'
            ? entry?.installed
            : entry?.installed?.[0]?.version

          if (!installed) {
            return { name: tool.name, ok: false, hint: 'not installed', brew: tool.name, brewType: tool.type }
          }

          return {
            name: tool.name,
            ok: true,
            version: parseVersion(installed),
          }
        } catch {
          return { name: tool.name, ok: false, hint: 'not installed', brew: tool.name, brewType: tool.type }
        }
      })
    ),
  ])

  return { core: coreResults, tools: toolResults }
}

function printResults(label: string, results: CheckResult[]) {
  log.message(pc.dim(`── ${label}`))
  for (const r of results) {
    const icon    = r.ok ? pc.green('✓') : pc.red('✗')
    const name    = r.ok ? pc.green(r.name.toLowerCase()) : pc.red(r.name.toLowerCase())
    const version = r.version ? pc.dim(`  ${r.version}`) : ''
    const hint    = r.hint    ? pc.dim(`  ${r.hint}`)    : ''
    log.message(`  ${icon}  ${name}${version}${hint}`)
  }
}

export default defineCommand({
  meta: { description: 'Verify environment health' },
  async run() {
    intro(pc.bgCyan(pc.black(' rig doctor ')))

    const s = spinner({ frames: SPINNER_FRAMES })
    s.start('Running checks...')
    const { core, tools } = await runChecks()
    s.stop('Done')

    const allOk     = [...core, ...tools].every(r => r.ok)
    const failCount = [...core, ...tools].filter(r => !r.ok).length

    printResults('core', core)
    printResults('required tools', tools)

    if (allOk) {
      outro(pc.green('All checks passed.'))
      return
    }

    const coreFailed   = core.filter(r => !r.ok)
    const toolsFailed  = tools.filter(r => !r.ok)
    const fixableTools = toolsFailed.filter(r => r.brew)

    if (coreFailed.length > 0) {
      log.warn(`${coreFailed.length} core check(s) failed — fix manually before continuing:`)
      for (const r of coreFailed) {
        const fix = CORE_FIX[r.name.toLowerCase()]
        log.message(`  ${pc.dim('→')} ${pc.cyan(r.name.toLowerCase())}: ${fix ? pc.dim(fix) : 'check your system installation'}`)
      }
    }

    if (fixableTools.length === 0) {
      outro(pc.yellow(`${failCount} check(s) failed.`))
      return
    }

    const shouldFix = await confirm({
      message: `Fix ${fixableTools.length} missing tool(s) now?`,
    })

    if (typeof shouldFix === 'symbol' || !shouldFix) {
      cancel('')
      log.info(`Run ${pc.cyan('rig install')} to install missing tools`)
      process.exit(0)
    }

    const sp = spinner({ frames: SPINNER_FRAMES })

    for (const tool of fixableTools) {
      sp.start(`Installing ${pc.cyan(tool.name.toLowerCase())}...`)
      try {
        const args = tool.brewType === 'cask'
          ? ['install', '--cask', tool.brew!]
          : ['install', tool.brew!]
        await execa('brew', args)
        sp.stop(`${pc.green('✓')} ${tool.name.toLowerCase()} installed`)
      } catch {
        sp.stop(`${pc.red('✗')} ${tool.name.toLowerCase()} — failed`)
      }
    }

    outro(pc.green('Done.'))
  },
})
