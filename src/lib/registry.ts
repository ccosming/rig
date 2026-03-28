import { readFileSync } from 'fs'
import { resolve } from 'path'
import { parse } from 'yaml'
import { RIG_DIR } from './constants.ts'

export interface Tool {
  name: string
  description: string
  brew: string
  type?: 'formula' | 'cask'
  required?: boolean
}

export interface Registry {
  packages: Record<string, Tool[]>
}

export function loadRegistry(): Registry {
  const filePath = resolve(RIG_DIR, 'config.yaml')
  return parse(readFileSync(filePath, 'utf8')) as Registry
}
