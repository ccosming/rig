import { defineCommand } from 'citty'
import { intro, outro, multiselect, spinner, cancel, log } from '@clack/prompts'
import { execa } from 'execa'
import { homedir } from 'os'
import { resolve } from 'path'
import pc from 'picocolors'
import { SPINNER_FRAMES, RIG_DIR } from '../lib/constants.ts'
import { loadRegistry, type ToolConfig } from '../lib/registry.ts'

const DOTFILES_DIR = resolve(RIG_DIR, 'dotfiles')

function expandHome(p: string): string {
  return p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : p
}

async function ensureChezmoiInit(): Promise<boolean> {
  try {
    const { stdout } = await execa('chezmoi', ['source-path'])
    if (stdout.trim() !== DOTFILES_DIR) {
      await execa('chezmoi', ['init', '--source', DOTFILES_DIR])
    }
    return true
  } catch {
    try {
      await execa('chezmoi', ['init', '--source', DOTFILES_DIR])
      return true
    } catch {
      return false
    }
  }
}

async function getManagedFiles(): Promise<Set<string>> {
  try {
    const { stdout } = await execa('chezmoi', ['managed', '--path-style', 'absolute'])
    return new Set(stdout.trim().split('\n').filter(Boolean))
  } catch {
    return new Set()
  }
}

type SyncStatus = 'synced' | 'partial' | 'new'

function getToolStatus(tool: ToolConfig, managed: Set<string>): SyncStatus {
  const files = tool.files.map(f => expandHome(f.source))
  const managedCount = files.filter(f => managed.has(f)).length
  if (managedCount === files.length) return 'synced'
  if (managedCount > 0) return 'partial'
  return 'new'
}

function statusLabel(status: SyncStatus): string {
  if (status === 'synced')  return pc.green('✓ synced')
  if (status === 'partial') return pc.yellow('~ partial')
  return pc.dim('new')
}

async function syncTool(name: string, tool: ToolConfig, managed: Set<string>): Promise<void> {
  for (const { source } of tool.files) {
    const dest = expandHome(source)
    if (managed.has(dest)) {
      await execa('chezmoi', ['apply', dest])
    } else {
      await execa('chezmoi', ['add', dest])
    }
  }
}

export default defineCommand({
  meta: { description: 'Sync dotfiles via chezmoi' },
  async run() {
    intro(pc.bgCyan(pc.black(' rig sync ')))

    const s = spinner({ frames: SPINNER_FRAMES })
    s.start('Checking chezmoi...')
    const initialized = await ensureChezmoiInit()

    if (!initialized) {
      s.stop(pc.red('✗ chezmoi init failed'))
      outro(pc.red('Make sure chezmoi is installed: brew install chezmoi'))
      process.exit(1)
    }

    const managed = await getManagedFiles()
    const registry = loadRegistry()
    s.stop(`chezmoi source: ${pc.dim(DOTFILES_DIR)}`)

    const tools = Object.entries(registry.tools)

    const options = tools.map(([name, tool]) => {
      const status = getToolStatus(tool, managed)
      return {
        value: name,
        label: status === 'new' ? name : (status === 'synced' ? pc.green(name) : pc.yellow(name)),
        hint: statusLabel(status),
      }
    })

    const preSelected = tools
      .filter(([, tool]) => getToolStatus(tool, managed) !== 'new')
      .map(([name]) => name)

    const selected = await multiselect({
      message: 'Select tools to sync',
      options,
      initialValues: preSelected,
      required: true,
    })

    if (typeof selected === 'symbol') {
      cancel('Cancelled.')
      process.exit(0)
    }

    const selectedTools = selected as string[]
    const toolMap = Object.fromEntries(tools)

    const sp = spinner({ frames: SPINNER_FRAMES })
    const results: { name: string, ok: boolean }[] = []

    for (const name of selectedTools) {
      sp.start(`Syncing ${pc.cyan(name)}...`)
      try {
        await syncTool(name, toolMap[name], managed)
        sp.stop(`${pc.green('✓')} ${name}`)
        results.push({ name, ok: true })
      } catch (err: any) {
        sp.stop(`${pc.red('✗')} ${name} — ${err?.message ?? 'failed'}`)
        results.push({ name, ok: false })
      }
    }

    const failed = results.filter(r => !r.ok)

    if (failed.length === 0) {
      outro(pc.green(`${results.length} tool(s) synced.`))
    } else {
      outro(pc.yellow(`${results.length - failed.length} synced, ${failed.length} failed.`))
    }
  },
})
