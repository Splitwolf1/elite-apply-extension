/**
 * AI navigator, content-script side. When the rules don't know the page (no
 * form, no Apply button we recognise, no Next/Submit), it shows the server a
 * numbered list of what's clickable and clicks the one element the model
 * picks. It never types and never submits: the rules-based filler does the
 * fields and the submit decision. The background caps steps per job.
 */
import { hasCaptcha, isConfirmationPage, isVisible, needsLogin } from './autofill'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const CLICKABLE = 'button, a[href], [role="button"], [role="link"], input[type=submit], input[type=button], summary'
const FIELDS = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=search]),textarea,select,[role="combobox"]'

const label = (el: HTMLElement) =>
  (el.innerText || (el as HTMLInputElement).value || el.getAttribute('aria-label') || el.title || '').replace(/\s+/g, ' ').trim()

export function snapshot() {
  const nodes: HTMLElement[] = []
  const elements: { i: number; text: string; role: string }[] = []
  const seen = new Set<string>()
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(CLICKABLE))) {
    if (!isVisible(el) || el.closest('#elite-apply-banner')) continue
    const text = label(el).slice(0, 80)
    if (!text || text.length < 2) continue
    const key = `${text}|${el.tagName}`
    if (seen.has(key)) continue
    seen.add(key)
    elements.push({ i: nodes.length, text, role: el.tagName === 'A' ? 'link' : 'button' })
    nodes.push(el)
    if (nodes.length >= 80) break
  }
  const headings = Array.from(document.querySelectorAll<HTMLElement>('h1, h2, h3, [role="alert"]'))
    .filter(isVisible).map((h) => label(h).slice(0, 120)).filter(Boolean).slice(0, 12)
  return { nodes, elements, headings }
}

const fieldCount = () => Array.from(document.querySelectorAll(FIELDS)).filter(isVisible).length

export type NavOutcome =
  | { kind: 'form' }                 // a form appeared: hand back to the filler
  | { kind: 'confirmed' }            // the page says it was submitted
  | { kind: 'stop'; why: string }    // the user's turn (sign-in, CAPTCHA, unsure, out of steps)
  | { kind: 'clicked' }              // clicked, nothing new yet (caller decides)

/**
 * Up to `steps` clicks towards the application form. Returns as soon as a
 * form shows up. If a click navigates away, this script ends and the next
 * page's script carries on (the step budget lives in the background).
 */
export async function navigateToForm(goal: string, steps = 4, stopOnForm = true): Promise<NavOutcome> {
  const tried: string[] = []
  for (let n = 0; n < steps; n++) {
    if (isConfirmationPage()) return { kind: 'confirmed' }
    if (needsLogin()) return { kind: 'stop', why: 'This site wants you to sign in. We never handle passwords.' }
    if (hasCaptcha()) return { kind: 'stop', why: 'This site shows a CAPTCHA. Please complete it.' }
    if (stopOnForm && fieldCount() >= 3) return { kind: 'form' }

    const { nodes, elements, headings } = snapshot()
    const step = await chrome.runtime.sendMessage({
      type: 'NAVIGATE',
      page: { goal, url: location.href, title: document.title, headings, elements, tried },
    }).catch(() => null) as { action?: string; i?: number; why?: string } | null

    if (!step || step.action === 'stop') return { kind: 'stop', why: step?.why || 'Not sure what to click here.' }
    if (step.action === 'done') return isConfirmationPage() ? { kind: 'confirmed' } : { kind: 'stop', why: step.why || 'This looks finished. Please check it.' }
    const el = nodes[Number(step.i)]
    if (!el) return { kind: 'stop', why: 'Not sure what to click here.' }
    tried.push(elements[Number(step.i)].text)
    el.scrollIntoView({ block: 'center' })
    await sleep(400 + Math.random() * 600)
    el.click()
    await sleep(2500)
  }
  return stopOnForm && fieldCount() >= 3 ? { kind: 'form' } : { kind: 'clicked' }
}
