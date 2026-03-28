import { defineCommand } from 'citty'
import { intro, outro, spinner, log } from '@clack/prompts'
import { execa } from 'execa'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import pc from 'picocolors'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RIG_DIR = resolve(__dirname, '../../')
const SPINNER_FRAMES = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷']

async function step(label: string, fn: () => Promise<void>): Promise<boolean> {
  const s = spinner({ frames: SPINNER_FRAMES })
  s.start(label)
  try {
    await fn()
    s.stop(`${pc.green('✓')} ${label}`)
    return true
  } catch (err: any) {
    s.stop(`${pc.red('✗')} ${label}`)
    console.error(err)
    return false
  }
}

export default defineCommand({
  meta: { description: 'Pull latest changes and rebuild rig' },
  async run() {
    intro(pc.bgCyan(pc.black(' rig update ')))

    const steps = [
      {
        label: 'Pulling latest changes...',
        fn: () => execa('git', ['-C', RIG_DIR, 'pull', '--ff-only']).then(() => {}),
      },
      {
        label: 'Installing dependencies...',
        fn: () => execa('pnpm', ['install', '--frozen-lockfile'], { cwd: RIG_DIR }).then(() => {}),
      },
      {
        label: 'Building...',
        fn: () => execa('pnpm', ['build'], { cwd: RIG_DIR }).then(() => {}),
      },
      {
        label: 'Linking CLI...',
        fn: () => execa('npm', ['link'], { cwd: RIG_DIR }).then(() => {}),
      },
    ]

    let failed = false
    for (const { label, fn } of steps) {
      const ok = await step(label, fn)
      if (!ok) { failed = true; break }
    }

    if (failed) {
      outro(pc.red('Update failed.'))
    } else {
      outro(pc.green('rig is up to date.'))
    }
  },
})
