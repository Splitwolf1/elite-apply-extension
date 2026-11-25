import type { PlasmoCSConfig } from 'plasmo'

/**
 * Sign-in hand-off. Runs only on the website's /extension/connect page: the
 * page (where the user is signed in) mints a per-device extension key and
 * posts it here; we pass it to the background, which saves it after checking
 * it with the server. Messages are accepted only from this same window and
 * origin, and the background re-checks the sender's URL against the server
 * this build talks to.
 */
export const config: PlasmoCSConfig = {
  matches: [
    'https://aijobtoolkit.com/extension/connect*',
    'https://www.aijobtoolkit.com/extension/connect*',
    'http://localhost/extension/connect*', // any port (dev); stripped from store builds
  ],
  run_at: 'document_start',
}

const WEB = 'elite-apply-web'
const EXT = 'elite-apply-extension'
const reply = (data: Record<string, unknown>) => window.postMessage({ source: EXT, ...data }, location.origin)

window.addEventListener('message', async (e: MessageEvent) => {
  if (e.source !== window || e.origin !== location.origin || e.data?.source !== WEB) return

  if (e.data.type === 'EA_PING') {
    reply({ type: 'EA_PONG', version: chrome.runtime.getManifest().version })
    return
  }

  if (e.data.type === 'EA_CONNECT') {
    const token = String(e.data.token ?? '')
    if (!/^[a-f0-9]{64}$/.test(token)) return reply({ type: 'EA_CONNECTED', ok: false, error: 'Malformed key' })
    try {
      const res = await chrome.runtime.sendMessage({ type: 'CONNECT_WITH_TOKEN', token })
      reply({ type: 'EA_CONNECTED', ok: !!res?.ok, email: res?.email ?? null, error: res?.error })
    } catch (err: any) {
      reply({ type: 'EA_CONNECTED', ok: false, error: String(err?.message ?? err) })
    }
  }
})
