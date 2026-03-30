import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'
import { parse } from 'yaml'
import { RIG_DIR } from './constants.ts'

export interface SyncConfig {
  files: { source: string }[]
}

export interface Tool {
  name: string
  description: string
  installer?: 'brew' | 'proto'
  type?: 'formula' | 'cask'
  version?: string
  core?: boolean
  required?: boolean
  sync?: SyncConfig
}

export function toolId(t: Tool): string {
  return t.name
}

// ─── Tool classification ──────────────────────────────────────────────────────

/** Infrastructure tools checked as system commands in doctor */
export function isCore(t: Tool): boolean {
  return t.core === true
}

/** Tool has dotfiles managed via rig sync */
export function isManaged(t: Tool): boolean {
  return (t.sync?.files?.length ?? 0) > 0
}

/** Converts a source path (e.g. ~/.config/foo) to its chezmoi path in dotfilesDir */
function toChezmoidPath(source: string, dotfilesDir: string): string {
  const relative = source.startsWith('~/') ? source.slice(2) : source.replace(homedir() + '/', '')
  const chezmoi = relative.split('/').map(part =>
    part.startsWith('.') ? 'dot_' + part.slice(1) : part
  ).join('/')
  return resolve(dotfilesDir, chezmoi)
}

/** At least one sync file physically exists in dotfilesDir */
export function hasDotfiles(t: Tool, dotfilesDir: string): boolean {
  if (!isManaged(t)) return false
  return t.sync!.files.some(f => existsSync(toChezmoidPath(f.source, dotfilesDir)))
}

/** All sync source files exist on the system (not in dotfiles/, but the actual paths) */
export function hasSystemFiles(t: Tool): boolean {
  if (!isManaged(t)) return false
  return t.sync!.files.every(f => {
    const expanded = f.source.startsWith('~/') ? resolve(homedir(), f.source.slice(2)) : f.source
    return existsSync(expanded)
  })
}

/** Tool should appear in doctor: core infra, has dotfiles committed, or user-marked required */
export function isTracked(t: Tool, dotfilesDir?: string): boolean {
  if (isCore(t)) return true
  if (t.required) return true
  if (dotfilesDir) return hasDotfiles(t, dotfilesDir)
  return isManaged(t)
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export interface PackageGroup {
  emoji: string
  tools: Tool[]
}

export interface Registry {
  packages: Record<string, PackageGroup>
}

export function loadRegistry(): Registry {
  const filePath = resolve(RIG_DIR, 'config.yaml')
  return parse(readFileSync(filePath, 'utf8')) as Registry
}

export function allTools(registry: Registry): Tool[] {
  return Object.values(registry.packages).flatMap(g => g.tools)
}
