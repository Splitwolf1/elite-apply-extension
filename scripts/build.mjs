/**
 * Cross-platform build (works in PowerShell, cmd and bash):
 *
 *   npm run build:dev    → build/chrome-mv3-dev   talks to http://localhost:3000, named "Elite Apply (DEV)"
 *   npm run build:prod   → build/chrome-mv3-prod  talks to https://aijobtoolkit.com
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const target = process.argv[2] === 'prod' ? 'prod' : 'dev'
const apiBase = target === 'prod' ? 'https://aijobtoolkit.com' : 'http://localhost:3000'
const args = ['plasmo', 'build', ...(target === 'dev' ? ['--tag=dev'] : [])]

const res = spawnSync('npx', args, {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, PLASMO_PUBLIC_API_BASE: apiBase },
})
if (res.status !== 0) process.exit(res.status ?? 1)

if (target === 'dev') {
  // A distinct name so the dev and production copies can't be confused in Chrome.
  const path = 'build/chrome-mv3-dev/manifest.json'
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  manifest.name = 'Elite Apply (DEV)'
  if (manifest.action) manifest.action.default_title = 'Elite Apply (DEV) — localhost:3000'
  writeFileSync(path, JSON.stringify(manifest, null, 2))
}
console.log(`\n✔ ${target} build → build/chrome-mv3-${target} (API: ${apiBase})`)
