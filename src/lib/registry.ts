import { readFileSync } from 'fs'
import { resolve } from 'path'
import { parse } from 'yaml'
import { RIG_DIR } from './constants.ts'

export interface Tool {
  name: string
  description: string
  installer?: 'brew' | 'proto'
  type?: 'formula' | 'cask'
  version?: string
  required?: boolean
}

export function toolId(t: Tool): string {
  return t.name
}

export interface ToolConfig {
  files: { source: string }[]
}

export interface PackageGroup {
  emoji: string
  tools: Tool[]
}

export interface Registry {
  packages: Record<string, PackageGroup>
  tools: Record<string, ToolConfig>
}

export function loadRegistry(): Registry {
  const filePath = resolve(RIG_DIR, 'config.yaml')
  return parse(readFileSync(filePath, 'utf8')) as Registry
}
