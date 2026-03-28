import { defineCommand, runMain } from 'citty'

const main = defineCommand({
  meta: {
    name: 'rig',
    version: '0.1.0',
    description: 'Machine provisioning CLI',
  },
  subCommands: {
    install: () => import('./commands/install.ts').then(m => m.default),
    sync:    () => import('./commands/sync.ts').then(m => m.default),
    doctor:  () => import('./commands/doctor.ts').then(m => m.default),
    update:  () => import('./commands/update.ts').then(m => m.default),  // ← agregar
  },
})

runMain(main)
