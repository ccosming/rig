import { defineCommand } from 'citty'
import { intro, outro, log, spinner } from '@clack/prompts'
import { execa } from 'execa'
import pc from 'picocolors'
import { SPINNER_FRAMES } from '../lib/constants.ts'
import { loadRegistry, type Tool } from '../lib/registry.ts'

interface CheckResult {
  name: string
  ok: boolean
  version?: string
  hint?: string
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

async function runChecks(): Promise<{ core: CheckResult[], tools: CheckResult[] }> {
  const registry = loadRegistry()

  const requiredTools = Object.values(registry.packages)
    .flat()
    .filter((t: Tool) => t.required)

  const coreChecks: Array<{ name: string, cmd: string, args?: string[] }> = [
    { name: 'Homebrew', cmd: 'brew',    args: ['--version'] },
    { name: 'git',      cmd: 'git',     args: ['--version'] },
    { name: 'node',     cmd: 'node',    args: ['--version'] },
    { name: 'chezmoi',  cmd: 'chezmoi', args: ['--version'] },
  ]

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
        try {
          const { stdout } = await execa('brew', ['info', '--json=v2', tool.brew])
          const data = JSON.parse(stdout)

          const entry = tool.type === 'cask'
            ? data.casks?.[0]
            : data.formulae?.[0]

          const installed = tool.type === 'cask'
            ? entry?.installed
            : entry?.installed?.[0]?.version

          if (!installed) {
            return { name: tool.name, ok: false, hint: 'not installed' }
          }

          return {
            name: tool.name,
            ok: true,
            version: parseVersion(installed),
          }
        } catch {
          return { name: tool.name, ok: false, hint: 'not installed' }
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
    const name    = r.ok ? pc.green(r.name) : pc.red(r.name)
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

    const allOk      = [...core, ...tools].every(r => r.ok)
    const failCount  = [...core, ...tools].filter(r => !r.ok).length

    printResults('core', core)
    printResults('required tools', tools)

    if (allOk) {
      outro(pc.green('All checks passed.'))
    } else {
      outro(pc.yellow(`${failCount} check(s) failed — run ${pc.cyan('rig install')} to fix`))
    }
  },
})
