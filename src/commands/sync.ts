import { defineCommand } from 'citty'
import { intro, outro, multiselect, spinner, cancel } from '@clack/prompts'
import { execa } from 'execa'
import { homedir } from 'os'
import { resolve } from 'path'
import pc from 'picocolors'
import { SPINNER_FRAMES, RIG_DIR } from '../lib/constants.ts'
import { loadRegistry, allTools, isManaged, type Tool } from '../lib/registry.ts'

const DOTFILES_DIR = resolve(RIG_DIR, 'dotfiles')

function chezmoi(args: string[]) {
  return execa('chezmoi', ['-S', DOTFILES_DIR, ...args])
}

function expandHome(p: string): string {
  return p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : p
}

async function getManagedFiles(): Promise<Set<string>> {
  try {
    const { stdout } = await chezmoi(['managed', '--path-style', 'absolute'])
    return new Set(stdout.trim().split('\n').filter(Boolean))
  } catch {
    return new Set()
  }
}

async function getPendingFiles(): Promise<Set<string>> {
  try {
    const { stdout } = await chezmoi(['status'])
    return new Set(
      stdout.trim().split('\n').filter(Boolean)
        .map(line => resolve(homedir(), line.slice(2)))
    )
  } catch {
    return new Set()
  }
}

type SyncStatus = 'pending' | 'new' | 'partial' | 'synced'

function getToolStatus(sync: { files: { source: string }[] }, managed: Set<string>, pending: Set<string>): SyncStatus {
  const files = sync.files.map(f => expandHome(f.source))
  const managedCount = files.filter(f => managed.has(f)).length

  if (managedCount === 0) return 'new'
  if (managedCount < files.length) return 'partial'
  if (files.some(f => pending.has(f))) return 'pending'
  return 'synced'
}

function statusHint(status: SyncStatus): string {
  if (status === 'synced')  return pc.green('✓ synced')
  if (status === 'pending') return pc.yellow('~ pending')
  if (status === 'partial') return pc.yellow('~ partial')
  return pc.dim('new')
}

function toolPriority(status: SyncStatus): number {
  if (status === 'pending') return 0
  if (status === 'partial') return 1
  if (status === 'new')     return 2
  return 3
}

async function syncTool(tool: Tool, managed: Set<string>): Promise<void> {
  for (const { source } of tool.sync!.files) {
    const dest = expandHome(source)
    if (managed.has(dest)) {
      await chezmoi(['apply', dest])
    } else {
      await chezmoi(['add', dest])
    }
  }
}

export default defineCommand({
  meta: { description: 'Sync dotfiles via chezmoi' },
  async run() {
    intro(pc.bgCyan(pc.black(' rig sync ')))

    const s = spinner({ frames: SPINNER_FRAMES })
    s.start('Checking dotfiles status...')

    const registry = loadRegistry()
    const [managed, pending] = await Promise.all([getManagedFiles(), getPendingFiles()])

    s.stop(`source: ${pc.dim(DOTFILES_DIR)}`)

    const managedTools = allTools(registry).filter(isManaged)

    const options = managedTools
      .map(tool => {
        const status = getToolStatus(tool.sync!, managed, pending)
        return {
          value: tool.name,
          label: status === 'synced' ? pc.green(tool.name) : status === 'new' ? tool.name : pc.yellow(tool.name),
          hint: statusHint(status),
          _priority: toolPriority(status),
        }
      })
      .sort((a, b) => a._priority - b._priority)

    const preSelected = managedTools
      .filter(tool => getToolStatus(tool.sync!, managed, pending) !== 'new')
      .map(tool => tool.name)

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
    const toolMap = new Map(managedTools.map(t => [t.name, t]))

    const sp = spinner({ frames: SPINNER_FRAMES })
    const results: { name: string, ok: boolean }[] = []

    for (const name of selectedTools) {
      sp.start(`Syncing ${pc.cyan(name)}...`)
      try {
        await syncTool(toolMap.get(name)!, managed)
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
