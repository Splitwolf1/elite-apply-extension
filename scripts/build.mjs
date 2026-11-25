/**
 * Cross-platform build (works in PowerShell, cmd and bash):
 *
 *   npm run build:dev              → build/chrome-mv3-dev, talks to http://localhost:3000
 *   npm run build:dev -- 3002      → same, but http://localhost:3002 (any port)
 *   npm run build:dev -- http://localhost:3002
 *   npm run build:prod             → build/chrome-mv3-prod, talks to https://aijobtoolkit.com
 *   npm run package:store          → prod build zipped for the Chrome Web Store
 *
 * The dev build is named "Elite Apply (DEV)" so it can't be confused with the
 * store one. Store builds have every localhost permission stripped.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'

const target = process.argv[2] === 'prod' || process.argv[2] === 'store' ? process.argv[2] : 'dev'
const arg = process.argv[3]
const devBase = !arg ? 'http://localhost:3000' : /^\d+$/.test(arg) ? `http://localhost:${arg}` : arg.replace(/\/$/, '')
const apiBase = target === 'dev' ? devBase : 'https://aijobtoolkit.com'
const outDir = `build/chrome-mv3-${target === 'dev' ? 'dev' : 'prod'}`

const run = (args) => {
  const res = spawnSync('npx', args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, PLASMO_PUBLIC_API_BASE: apiBase },
  })
  if (res.status !== 0) process.exit(res.status ?? 1)
}

run(['plasmo', 'build', ...(target === 'dev' ? ['--tag=dev'] : [])])

const path = `${outDir}/manifest.json`
const manifest = JSON.parse(readFileSync(path, 'utf8'))
if (target === 'dev') {
  manifest.name = 'Elite Apply (DEV)'
  if (manifest.action) manifest.action.default_title = `Elite Apply (DEV) — ${apiBase.replace(/^https?:\/\//, '')}`
} else {
  // Store builds talk only to production: no localhost access at all.
  const notLocal = (p) => !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(p)
  manifest.host_permissions = (manifest.host_permissions ?? []).filter(notLocal)
  for (const cs of manifest.content_scripts ?? []) cs.matches = cs.matches.filter(notLocal)
  manifest.content_scripts = (manifest.content_scripts ?? []).filter((cs) => cs.matches.length)
}
writeFileSync(path, JSON.stringify(manifest, null, 2))

if (target === 'store') {
  // Zip the cleaned build for upload (plasmo package would re-zip the raw build).
  const zip = `build/elite-apply-${manifest.version}-store.zip`
  if (existsSync(zip)) rmSync(zip)
  const ps = `Compress-Archive -Path '${outDir}/*' -DestinationPath '${zip}'`
  const res = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'inherit' })
    : spawnSync('sh', ['-c', `cd ${outDir} && zip -qr ../../${zip} .`], { stdio: 'inherit' })
  if (res.status !== 0) process.exit(res.status ?? 1)
  console.log(`\n✔ store zip → ${zip}`)
}
console.log(`\n✔ ${target} build → ${outDir} (API: ${apiBase})`)
