import type { PlasmoCSConfig } from 'plasmo'

/**
 * Main-world bridge for React-based dropdowns (react-select: Greenhouse,
 * Ashby and many career sites).
 *
 * Content scripts live in an isolated world and cannot see React internals.
 * react-select also only opens its menu after a focus event, which never
 * fires in a background or minimized window. This script runs in the page's
 * own world, finds the Select instance through the React fiber of the
 * element the content script tagged, and uses the component's own API —
 * reading its options and calling selectOption() — so no focus is needed.
 *
 * Protocol (window.postMessage, same window):
 *   → { __ea: 'rs-options', id, nonce }          ← { __ea: 'rs-reply', nonce, labels: string[] | null }
 *   → { __ea: 'rs-select',  id, index, nonce }   ← { __ea: 'rs-reply', nonce, ok: boolean }
 * `id` is the value of the data-ea-rs attribute set by the content script.
 */
export const config: PlasmoCSConfig = {
  matches: ['<all_urls>'],
  all_frames: true,
  world: 'MAIN',
  run_at: 'document_idle',
}

interface SelectInstance {
  selectOption: (option: unknown) => void
  props: { options?: unknown[]; getOptionLabel?: (o: unknown) => string }
}

function findSelect(el: Element): SelectInstance | null {
  const key = Object.keys(el).find((k) => k.startsWith('__reactFiber'))
  let fiber = key ? (el as any)[key] : null
  for (let i = 0; fiber && i < 60; i++, fiber = fiber.return) {
    const s = fiber.stateNode
    if (s && typeof s.selectOption === 'function' && s.props) return s as SelectInstance
  }
  return null
}

const flatten = (opts: unknown[] = []): unknown[] =>
  opts.flatMap((o: any) => (o && Array.isArray(o.options) ? o.options : [o]))

function label(sel: SelectInstance, o: any): string {
  try {
    return String(sel.props.getOptionLabel ? sel.props.getOptionLabel(o) : o?.label ?? o?.value ?? '')
  } catch {
    return String(o?.label ?? '')
  }
}

window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || typeof e.data.__ea !== 'string') return
  const { __ea, id, nonce } = e.data
  if (__ea !== 'rs-options' && __ea !== 'rs-select') return

  const el = document.querySelector(`[data-ea-rs="${CSS.escape(String(id))}"]`)
  const sel = el ? findSelect(el) : null
  const options = sel ? flatten(sel.props.options) : []

  if (__ea === 'rs-options') {
    window.postMessage({ __ea: 'rs-reply', nonce, labels: sel ? options.map((o) => label(sel, o)) : null }, '*')
    return
  }
  const option = options[Number(e.data.index)]
  let ok = false
  if (sel && option !== undefined) {
    try {
      sel.selectOption(option)
      ok = true
    } catch {
      ok = false
    }
  }
  window.postMessage({ __ea: 'rs-reply', nonce, ok }, '*')
})
