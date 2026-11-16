/**
 * Universal job-application autofill engine.
 *
 * Works on any ATS or company career site: classifies each field by its
 * question text, fills it with a React-safe setter, and handles native and
 * custom choice controls. It never enters passwords, creates accounts, solves
 * CAPTCHAs, ticks consent boxes, or guesses legal answers (work authorization,
 * sponsorship) — those are left for the user and reported as unresolved.
 */

import type { ScreeningAnswers } from './storage'

export interface Profile {
  fullName: string
  firstName: string
  lastName: string
  email: string
  phone: string
  location: string
  zipCode: string
  addressLine1?: string
  addressLine2?: string
  city?: string
  state?: string
  country?: string
  linkedinUrl: string
  githubUrl: string
  websiteUrl: string
  yearsOfExperience: string | number
  highestDegree: string
  expectedSalary: string
  professionalTitle: string
}

export interface FillContext {
  profile: Profile
  screening: ScreeningAnswers
  job: { jobTitle?: string | null; companyName?: string | null; coverLetter?: string | null }
  /** Background-fetched résumé (the best fit for this job when there are several). */
  getResumeFile: () => Promise<File | null>
  /** Label of the résumé getResumeFile returned, once fetched. */
  resumeLabel?: () => string | undefined
  /** AI answer for an open-ended question (empty string when unavailable). */
  askAI: (question: string) => Promise<string>
}

export interface FillReport {
  filled: number
  /** Questions the engine could not answer. */
  unresolved: string[]
  /** Subset of unresolved that the form marks as required. */
  requiredUnresolved: string[]
  resumeUploaded: boolean
  /** Which résumé was attached (when the user has several). */
  resumeLabel?: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').replace(/\*/g, '').trim()

// ── DOM helpers ──────────────────────────────────────────────────────────────

/** Sets a value the way a user would, so React/Vue/Angular state updates. */
export function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
    : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  el.focus()
  if (setter) setter.call(el, value)
  else (el as HTMLInputElement).value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  el.dispatchEvent(new Event('blur', { bubbles: true }))
}

export function isVisible(el: Element): boolean {
  const r = (el as HTMLElement).getBoundingClientRect()
  const cs = getComputedStyle(el as HTMLElement)
  return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'
}

/** Best-effort question text for a form control. */
export function questionText(el: Element): string {
  const aria = el.getAttribute('aria-label')
  if (aria) return norm(aria)

  const labelledBy = el.getAttribute('aria-labelledby')
  if (labelledBy) {
    const t = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
    if (norm(t)) return norm(t)
  }

  const input = el as HTMLInputElement
  if (input.labels?.[0] && input.type !== 'radio' && input.type !== 'checkbox') return norm(input.labels[0].textContent)
  if (input.id) {
    const lbl = document.querySelector(`label[for="${CSS.escape(input.id)}"]`)
    if (lbl && input.type !== 'radio' && input.type !== 'checkbox') return norm(lbl.textContent)
  }

  // Radio/checkbox groups and custom widgets: the question lives on the group
  const fs = el.closest('fieldset')
  const legend = fs?.querySelector('legend')
  if (legend && norm(legend.textContent)) return norm(legend.textContent)

  const group = el.closest('[role="radiogroup"],[role="group"]')
  if (group) {
    const gl = group.getAttribute('aria-label') ?? ''
    if (gl) return norm(gl)
  }

  // Walk up to the nearest container that has its own label-like text
  let p: Element | null = el.parentElement
  for (let depth = 0; p && depth < 6; depth++, p = p.parentElement) {
    const lbl = p.querySelector(':scope > label, :scope > legend, :scope > [class*="label" i], :scope > div > label')
    if (lbl && !lbl.contains(el) && norm(lbl.textContent)) return norm(lbl.textContent)
  }

  return norm(input.placeholder || input.name || el.getAttribute('data-automation-id'))
}

function isRequired(el: Element, question: string): boolean {
  return (el as HTMLInputElement).required
    || el.getAttribute('aria-required') === 'true'
    || /\*\s*$|\(required\)/i.test(question)
    || !!el.closest('[class*="required" i]')
}

// ── Field classification ─────────────────────────────────────────────────────

type FieldKind =
  | 'firstName' | 'lastName' | 'fullName' | 'preferredName' | 'email' | 'phone'
  | 'city' | 'state' | 'zip' | 'country' | 'location' | 'address' | 'address2'
  | 'linkedin' | 'github' | 'website' | 'currentTitle' | 'currentCompany'
  | 'yearsExperience' | 'salary' | 'noticePeriod' | 'startDate' | 'education'
  | 'coverLetter' | 'workAuth' | 'sponsorship' | 'relocate' | 'eeo' | 'howHeard'
  | 'consent' | 'password' | 'unknown'

const RULES: [FieldKind, RegExp][] = [
  ['password', /password/],
  ['consent', /\b(i agree|i acknowledge|i consent|i certify|privacy (policy|notice)|terms (of|and)|consent)\b/],
  ['eeo', /\b(gender|sex\b|race|ethnic|hispanic|latino|veteran|disabilit|pronoun|sexual orientation|transgender|self.?identif)/],
  ['sponsorship', /sponsor|visa status|h-?1b/],
  ['workAuth', /(legally )?(authori[sz]ed|eligible|right) to work|work authori[sz]ation|work permit/],
  ['relocate', /relocat/],
  ['preferredName', /preferred (first )?name|nickname|name you('d| would) (prefer|like)|prefer(red)? to be called/],
  ['firstName', /first.?name|given name|forename/],
  ['lastName', /last.?name|surname|family name/],
  ['fullName', /^(full )?name$|full.?name|your name|legal name/],
  ['email', /e-?mail/],
  ['phone', /phone|mobile|cell/],
  ['linkedin', /linkedin/],
  ['github', /github/],
  ['website', /website|portfolio|personal (site|url)|blog/],
  ['address2', /address line ?2|apartment|\bapt\b|suite|unit (number|no)/],
  ['zip', /zip|postal/],
  ['city', /\bcity\b|town/],
  ['state', /\bstate\b|province|region/],
  ['country', /country/],
  ['address', /street|address line|^address/],
  ['location', /location|where (are you|do you) (based|live)|current residence/],
  ['currentCompany', /current (company|employer)|most recent (company|employer)/],
  ['currentTitle', /current (title|role|position)|job title/],
  ['yearsExperience', /years of (professional |relevant )?experience|how many years/],
  ['salary', /salary|compensation|pay (expectation|range)|desired pay/],
  ['noticePeriod', /notice period/],
  ['startDate', /start date|when can you start|available to start|availability/],
  ['education', /degree|education level|highest level/],
  ['coverLetter', /cover letter|why (do you want|are you interested)|additional information/],
  ['howHeard', /how did you (hear|find|learn)|source|referred by|where did you/],
]

/**
 * Profile-field kinds are short labels ("Current company", "Email"). A long
 * question that merely mentions one ("Are you subject to agreements with your
 * current employer?") is a real question, so it stays 'unknown'.
 */
const SHORT_LABEL_KINDS = new Set<FieldKind>([
  'firstName', 'lastName', 'fullName', 'email', 'phone', 'city', 'state', 'zip', 'country',
  'address', 'address2', 'location', 'linkedin', 'github', 'website', 'currentTitle', 'currentCompany', 'education',
])

export function classify(question: string): FieldKind {
  const q = question.toLowerCase()
  for (const [kind, re] of RULES) {
    if (!re.test(q)) continue
    if (SHORT_LABEL_KINDS.has(kind) && q.length > 70) return 'unknown'
    return kind
  }
  return 'unknown'
}

/** Whether a control (or its widget) currently holds an answer. */
function hasAnswer(el: Element): boolean {
  if (el instanceof HTMLInputElement && el.type === 'radio') {
    return Array.from(document.querySelectorAll<HTMLInputElement>(`input[type=radio][name="${CSS.escape(el.name)}"]`)).some((r) => r.checked) || el.checked
  }
  if (el instanceof HTMLInputElement && el.type === 'checkbox') return el.checked
  if (el instanceof HTMLInputElement && el.type === 'file') return !!el.files?.length
  if (el instanceof HTMLSelectElement) return el.selectedIndex > 0 && !!el.value
  const chosen = el.closest('[class*="control" i]')?.querySelector('[class*="single-value" i], [class*="multi-value" i]')
  if (chosen && norm(chosen.textContent)) return true
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return !!el.value.trim() && el.getAttribute('role') !== 'combobox'
  const shown = norm(el.textContent)
  return !!shown && !/^select|^choose|^--/i.test(shown)
}

function locationParts(location: string) {
  const parts = location.split(',').map((s) => s.trim()).filter(Boolean)
  return { city: parts[0] ?? '', state: parts[1] ?? '', country: parts[2] ?? (parts.length === 2 ? '' : '') }
}

const yesNo = (v: boolean | null) => (v === null ? null : v ? 'Yes' : 'No')

/** Plain-text value for a field, or null when the engine must not guess. */
function valueFor(kind: FieldKind, ctx: FillContext): string | null {
  const p = ctx.profile
  const s = ctx.screening
  const loc = locationParts(p.location ?? '')
  switch (kind) {
    case 'firstName': case 'preferredName': return p.firstName || null
    case 'lastName': return p.lastName || null
    case 'fullName': return p.fullName || `${p.firstName} ${p.lastName}`.trim() || null
    case 'email': return p.email || null
    case 'phone': return p.phone || null
    case 'city': return p.city || loc.city || null
    case 'state': return p.state || loc.state || null
    case 'country': return p.country || loc.country || null
    case 'address': return p.addressLine1 || null
    case 'address2': return p.addressLine2 || null
    case 'zip': return p.zipCode || null
    case 'location': return p.location || null
    case 'linkedin': return p.linkedinUrl || null
    case 'github': return p.githubUrl || null
    case 'website': return p.websiteUrl || p.linkedinUrl || null
    case 'currentTitle': return p.professionalTitle || null
    case 'yearsExperience': return p.yearsOfExperience ? String(p.yearsOfExperience) : null
    case 'salary': return s.salaryExpectation || p.expectedSalary || null
    case 'noticePeriod': return s.noticePeriod || null
    case 'education': return p.highestDegree || null
    case 'coverLetter': return ctx.job.coverLetter || null
    case 'workAuth': return yesNo(s.workAuthorized)
    case 'sponsorship': return yesNo(s.needsSponsorship)
    case 'relocate': return yesNo(s.willingToRelocate)
    case 'howHeard': return s.howDidYouHear || null
    default: return null
  }
}

const DECLINE = /decline|prefer not|don.?t wish|do not wish|choose not|not to (disclose|answer|say|self)|rather not|i don.?t want/i

/** Picks the best option text for a choice question, or null. */
function chooseOption(kind: FieldKind, options: string[], ctx: FillContext): number {
  if (kind === 'eeo') return options.findIndex((o) => DECLINE.test(o))
  const target = valueFor(kind, ctx)
  if (!target) return -1
  const t = target.toLowerCase()
  if (t === 'yes' || t === 'no') return options.findIndex((o) => new RegExp(`^\\s*${t}\\b`, 'i').test(o))
  // Exact, then contains, then contained-in
  let i = options.findIndex((o) => o.trim().toLowerCase() === t)
  if (i < 0) i = options.findIndex((o) => o.toLowerCase().includes(t))
  if (i < 0) i = options.findIndex((o) => o.trim() && t.includes(o.trim().toLowerCase()))
  return i
}

// ── Controls ─────────────────────────────────────────────────────────────────

async function fillText(el: HTMLInputElement | HTMLTextAreaElement, q: string, kind: FieldKind, ctx: FillContext): Promise<boolean> {
  let v = valueFor(kind, ctx)
  if (v === null && kind === 'unknown' && q.length > 3) {
    v = (await ctx.askAI(q).catch(() => '')) || null
  }
  if (!v) return false
  setNativeValue(el, v)
  return true
}

/**
 * For questions the rules don't cover, let the AI pick one of the options the
 * form actually offers. Legal and identity questions never reach here — they
 * are classified as workAuth/sponsorship/eeo and answered only from settings.
 */
async function aiPick(question: string, options: string[], ctx: FillContext): Promise<number> {
  const real = options.map((o, i) => [o.trim(), i] as const).filter(([o]) => o && !/^(select|choose|--)/i.test(o))
  if (!question || real.length < 2) return -1
  const answer = (await ctx.askAI(
    `${question}\nChoose exactly one of these options and reply with the option text only: ${real.map(([o]) => o).join(' | ')}`
  ).catch(() => '')).trim().toLowerCase()
  if (!answer) return -1
  const hit = real.find(([o]) => o.toLowerCase() === answer) ?? real.find(([o]) => answer.includes(o.toLowerCase()))
  return hit ? hit[1] : -1
}

async function pick(kind: FieldKind, q: string, options: string[], ctx: FillContext): Promise<number> {
  const idx = chooseOption(kind, options, ctx)
  if (idx >= 0 || kind !== 'unknown') return idx
  // A question that offers "prefer not to say" is voluntary self-identification
  // (age, gender, ethnicity…): decline rather than let the AI guess.
  const decline = options.findIndex((o) => DECLINE.test(o))
  if (decline >= 0) return decline
  return aiPick(q, options, ctx)
}

const ids = new WeakMap<Element, number>()
let idSeq = 0
function elementId(el: Element): number {
  if (!ids.has(el)) ids.set(el, ++idSeq)
  return ids.get(el)!
}

async function fillSelect(el: HTMLSelectElement, q: string, kind: FieldKind, ctx: FillContext): Promise<boolean> {
  const opts = Array.from(el.options)
  const idx = await pick(kind, q, opts.map((o) => o.text), ctx)
  if (idx < 0 || !opts[idx].value) return false
  setNativeValue(el, opts[idx].value)
  return true
}

function optionLabel(input: HTMLInputElement): string {
  return norm(input.labels?.[0]?.textContent ?? input.getAttribute('aria-label') ?? input.value)
}

async function fillRadioGroup(radios: HTMLInputElement[], q: string, kind: FieldKind, ctx: FillContext): Promise<boolean> {
  const idx = await pick(kind, q, radios.map(optionLabel), ctx)
  if (idx < 0) return false
  radios[idx].click()
  return true
}

// ── React dropdown bridge (contents/react-bridge.ts, main world) ─────────────

let bridgeSeq = 0
function bridge<T>(msg: Record<string, unknown>, timeoutMs = 800): Promise<T | null> {
  const nonce = `${Date.now()}-${Math.random()}`
  return new Promise((resolve) => {
    const timer = setTimeout(() => { window.removeEventListener('message', onMsg); resolve(null) }, timeoutMs)
    function onMsg(e: MessageEvent) {
      if (e.source !== window || e.data?.__ea !== 'rs-reply' || e.data.nonce !== nonce) return
      clearTimeout(timer)
      window.removeEventListener('message', onMsg)
      resolve(e.data as T)
    }
    window.addEventListener('message', onMsg)
    window.postMessage({ ...msg, nonce }, '*')
  })
}

function tagForBridge(el: HTMLElement): string {
  const target = (el.matches('input') ? el : el.querySelector('input')) ?? el
  const id = target.getAttribute('data-ea-rs') ?? `ea${++bridgeSeq}`
  target.setAttribute('data-ea-rs', id)
  return id
}

/** Options rendered for this combobox only (never another widget's list). */
function ownOptions(el: HTMLElement): HTMLElement[] {
  const input = (el.matches('input') ? el : el.querySelector('input')) ?? el
  const ctrl = input.getAttribute('aria-controls') ?? input.getAttribute('aria-owns')
  const lb = ctrl ? document.getElementById(ctrl) : null
  if (lb) return Array.from(lb.querySelectorAll<HTMLElement>('[role="option"]'))
  const rs = /react-select-([\w-]+?)-(placeholder|input|value|listbox|live-region)/.exec(`${input.getAttribute('aria-describedby') ?? ''} ${input.id}`)
  if (rs) {
    const opts = Array.from(document.querySelectorAll<HTMLElement>(`[id^="react-select-${CSS.escape(rs[1])}-option-"]`))
    if (opts.length) return opts
  }
  let p: Element | null = el.parentElement
  for (let i = 0; p && i < 6; i++, p = p.parentElement) {
    const opts = p.querySelectorAll<HTMLElement>('[role="option"]')
    if (opts.length) return Array.from(opts)
  }
  return []
}

/**
 * Custom dropdowns. First through the React bridge (works with no window
 * focus); otherwise open the widget with events and click one of its own
 * options.
 */
async function fillCombobox(el: HTMLElement, q: string, kind: FieldKind, ctx: FillContext): Promise<boolean> {
  const id = tagForBridge(el)
  const listed = await bridge<{ labels: string[] | null }>({ __ea: 'rs-options', id })
  if (listed?.labels?.length) {
    const idx = await pick(kind, q, listed.labels, ctx)
    if (idx < 0) return false
    const done = await bridge<{ ok: boolean }>({ __ea: 'rs-select', id, index: idx })
    return !!done?.ok
  }

  // Non-React widgets: open, optionally type to filter, pick from its own list
  const target = valueFor(kind, ctx)
  const input = (el.matches('input') ? el : el.querySelector('input')) as HTMLInputElement | null
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
  el.click()
  if (input && target) setNativeValue(input, target)
  await sleep(500)
  const options = ownOptions(el).filter(isVisible)
  const idx = await pick(kind, q, options.map((o) => norm(o.textContent)), ctx)
  if (idx < 0) {
    if (input && target) setNativeValue(input, '') // don't leave a half-typed search behind
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return false
  }
  options[idx].click()
  await sleep(200)
  return true
}

async function uploadResume(input: HTMLInputElement, ctx: FillContext): Promise<boolean> {
  const file = await ctx.getResumeFile().catch(() => null)
  if (!file) return false
  const dt = new DataTransfer()
  dt.items.add(file)
  input.files = dt.files
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
  return true
}

/**
 * The résumé file input. Many ATSs (Workday, SmartRecruiters…) hide the real
 * <input type=file> behind a styled drop zone, so look at the input's own
 * attributes *and* the text of the box around it. Cover-letter inputs are
 * skipped; failing all else, the only document input on the page.
 */
function pickResumeInput(files: HTMLInputElement[]): HTMLInputElement | null {
  const RESUME = /resume|résumé|\bcv\b|curriculum/i
  const OTHER = /cover.?letter|transcript|portfolio|photo|avatar|image|writing sample/i
  const describe = (f: HTMLInputElement) => {
    const own = [questionText(f), f.name, f.id, f.getAttribute('aria-label'), f.getAttribute('data-automation-id'), f.getAttribute('data-testid')].join(' ')
    let box: Element | null = f.parentElement
    for (let i = 0; i < 4 && box && norm(box.textContent).length < 40; i++) box = box.parentElement
    return { own, around: norm(box?.textContent).slice(0, 300) }
  }
  const docs = files.filter((f) => !f.disabled && (!f.accept || /pdf|doc|application|\*/i.test(f.accept)))
  const scored = docs.map((f) => {
    const { own, around } = describe(f)
    const score = (RESUME.test(own) ? 4 : 0) + (RESUME.test(around) ? 2 : 0)
      - (OTHER.test(own) ? 5 : 0) - (OTHER.test(around) && !RESUME.test(around) ? 3 : 0)
    return { f, score }
  }).sort((a, b) => b.score - a.score)
  if (scored.length && scored[0].score > 0) return scored[0].f
  const plain = scored.filter((x) => x.score === 0)
  return plain.length === 1 ? plain[0].f : null
}

// ── Page-level checks ────────────────────────────────────────────────────────

/**
 * A CAPTCHA the user has to solve. Invisible/score-based ones (Greenhouse
 * loads invisible reCAPTCHA Enterprise on every form) need no action.
 */
export function hasCaptcha(): boolean {
  return Array.from(document.querySelectorAll<HTMLIFrameElement>(
    'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare"]'
  )).some((f) => !/size=invisible/.test(f.src) && isVisible(f) && f.offsetHeight >= 60 && f.offsetWidth >= 280)
}

export function needsLogin(): boolean {
  return Array.from(document.querySelectorAll('input[type="password"]')).some(isVisible)
}

export function isConfirmationPage(): boolean {
  const url = location.href.toLowerCase()
  if (/\/(confirmation|thank-?you|thanks|application-submitted|success)\b/.test(url)) return true
  const text = (document.body?.innerText ?? '').slice(0, 5000).toLowerCase()
  return /thank you for (applying|your application|your interest)|application (has been |was )?(successfully )?(submitted|received)|we('ve| have) received your application|your application is complete/.test(text)
}

// ── Main fill pass ───────────────────────────────────────────────────────────

/** Fills every visible, empty field under `root`. Safe to call repeatedly. */
export async function fillForm(root: ParentNode, ctx: FillContext): Promise<FillReport> {
  const report: FillReport = { filled: 0, unresolved: [], requiredUnresolved: [], resumeUploaded: false }
  const missed: [string, Element][] = []
  const miss = (q: string, el: Element) => { if (q) missed.push([q, el]) }

  // Text inputs and textareas
  const texts = root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    'input:not([type]),input[type=text],input[type=email],input[type=tel],input[type=url],input[type=number],textarea'
  )
  for (const el of texts) {
    if (!isVisible(el) || el.disabled || el.readOnly || el.value.trim()) continue
    if (el.getAttribute('role') === 'combobox' || el.closest('[role="combobox"]')) continue
    const q = questionText(el)
    const kind = classify(q)
    if (kind === 'password' || kind === 'consent') continue
    if (await fillText(el, q, kind, ctx)) report.filled++
    else miss(q, el)
  }

  // Native selects
  for (const el of root.querySelectorAll<HTMLSelectElement>('select')) {
    if (!isVisible(el) || el.disabled) continue
    if (el.selectedIndex > 0 && el.value) continue
    const q = questionText(el)
    if (await fillSelect(el, q, classify(q), ctx)) report.filled++
    else miss(q, el)
  }

  // Radio groups
  const groups = new Map<string, HTMLInputElement[]>()
  for (const r of root.querySelectorAll<HTMLInputElement>('input[type=radio]')) {
    const key = r.name || questionText(r)
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  for (const radios of groups.values()) {
    if (radios.some((r) => r.checked) || !radios.some(isVisible)) continue
    const q = questionText(radios[0])
    if (await fillRadioGroup(radios, q, classify(q), ctx)) report.filled++
    else miss(q, radios[0])
  }

  // Custom comboboxes
  for (const el of root.querySelectorAll<HTMLElement>('[role="combobox"], button[aria-haspopup="listbox"]')) {
    if (!isVisible(el)) continue
    // react-select keeps its chosen value beside the (empty) search input
    const chosen = el.closest('[class*="control" i]')?.querySelector('[class*="single-value" i], [class*="multi-value" i]')
    if (chosen && norm(chosen.textContent)) continue
    const shown = el.matches('input') ? '' : norm(el.textContent)
    if (shown && !/^select|^choose|^--/i.test(shown)) continue
    const q = questionText(el)
    const kind = classify(q)
    if (kind === 'consent') continue
    if (await fillCombobox(el, q, kind, ctx)) report.filled++
    else miss(q, el)
  }

  // Checkbox groups: voluntary demographic questions (Ashby asks age, gender,
  // ethnicity this way) get "prefer not to answer". Required consent boxes
  // are the user's decision and are only reported.
  const cbGroups = new Map<string, HTMLInputElement[]>()
  let segment = 0
  for (const cb of root.querySelectorAll<HTMLInputElement>('input[type=checkbox]')) {
    if (!isVisible(cb)) continue
    const container = cb.closest('fieldset, [role="group"]')
    const base = container ? `group${elementId(container)}` : `name:${cb.name || elementId(cb)}`
    const key = `${base}#${segment}`
    cbGroups.set(key, [...(cbGroups.get(key) ?? []), cb])
    // One fieldset can hold several questions, each ending with its own
    // "prefer not to answer": start a new group after one.
    if (DECLINE.test(optionLabel(cb))) segment++
  }
  for (const group of cbGroups.values()) {
    if (group.some((c) => c.checked)) continue
    const labels = group.map(optionLabel)
    const decline = labels.findIndex((l) => DECLINE.test(l))
    if (group.length > 1 && decline >= 0) {
      group[decline].click()
      report.filled++
      continue
    }
    for (const cb of group) {
      const q = optionLabel(cb) || questionText(cb)
      if (classify(q) === 'consent' && isRequired(cb, q)) miss(q, cb)
    }
  }

  // Résumé upload — the file input labelled résumé/CV, or the only one
  const files = Array.from(root.querySelectorAll<HTMLInputElement>('input[type=file]'))
  const resumeInput = pickResumeInput(files)
  if (resumeInput && !resumeInput.files?.length) {
    report.resumeUploaded = await uploadResume(resumeInput, ctx)
    if (report.resumeUploaded) report.resumeLabel = ctx.resumeLabel?.()
    if (report.resumeUploaded) report.filled++
    else miss('Résumé upload', resumeInput)
  }

  // Report only what is still empty: widgets update asynchronously, and a
  // follow-up action can answer a field an earlier step missed.
  await sleep(250)
  for (const [q, el] of missed) {
    if (q === 'Résumé upload' ? report.resumeUploaded : hasAnswer(el)) continue
    report.unresolved.push(q)
    if (isRequired(el, q)) report.requiredUnresolved.push(q)
  }
  report.unresolved = [...new Set(report.unresolved)]
  report.requiredUnresolved = [...new Set(report.requiredUnresolved)]
  return report
}

// ── Buttons ──────────────────────────────────────────────────────────────────

function buttons(root: ParentNode = document): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('button, input[type=submit], a[role=button], [role=button]'))
    .filter((b) => isVisible(b) && !(b as HTMLButtonElement).disabled)
}
const btnText = (b: HTMLElement) => norm(b.textContent || (b as HTMLInputElement).value || b.getAttribute('aria-label'))

/**
 * The form's submit button. Most specific wording wins: on Greenhouse a top
 * "Apply" button only scrolls to the form, the real one says "Submit application".
 */
export function findSubmit(root?: ParentNode): HTMLElement | undefined {
  const all = buttons(root)
  const tiers = [
    /^submit( (my |your |the )?application)?$/i,
    /^(send|complete|finish)( (my |your )?application)?$/i,
    /^apply$/i,
  ]
  for (const re of tiers) {
    const hits = all.filter((b) => re.test(btnText(b)))
    // Prefer a real submit control inside a form
    const best = hits.find((b) => (b as HTMLButtonElement).type === 'submit' && b.closest('form')) ?? hits[hits.length - 1]
    if (best) return best
  }
  return undefined
}
export const findNext = (root?: ParentNode) =>
  buttons(root).find((b) => /^(next|continue|save (and|&) continue|proceed|review)( step)?$/i.test(btnText(b)))

/** The "Apply" entry point on a job description page (link or button). */
export function findApplyEntry(): HTMLElement | null {
  const els = Array.from(document.querySelectorAll<HTMLElement>('a, button, [role=button]')).filter(isVisible)
  return els.find((e) => /^(apply( now| for this (job|position|role))?|apply manually|start (your )?application|i'?m interested)$/i.test(btnText(e))) ?? null
}

let bannerRecheck: (() => Promise<void>) | null = null

/** What "Check again" on the banner does (re-fill empty fields and re-count). */
export function setBannerRecheck(fn: (() => Promise<void>) | null) {
  bannerRecheck = fn
}

/** Status banner: what was filled, what still needs the user, plus Check again / close. */
export function showReviewBanner(report: FillReport, mode: 'review' | 'blocked', reason?: string) {
  document.getElementById('elite-apply-banner')?.remove()
  const el = document.createElement('div')
  el.id = 'elite-apply-banner'
  el.style.cssText = 'position:fixed;z-index:2147483647;bottom:16px;right:16px;max-width:360px;background:#fff7ed;border:2px solid #ea580c;border-radius:12px;padding:14px 16px;font:13px/1.45 system-ui,sans-serif;color:#1f2937;box-shadow:0 10px 30px rgba(0,0,0,.18)'
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const todo = report.requiredUnresolved.length ? report.requiredUnresolved : report.unresolved
  const attached = report.resumeUploaded ? ` and attached your résumé${report.resumeLabel ? ` (<b>${esc(report.resumeLabel)}</b>)` : ''}` : ''
  const ready = mode === 'review' && !report.requiredUnresolved.length
  el.innerHTML = `<button data-ea="close" title="Hide" style="position:absolute;top:6px;right:8px;border:0;background:none;font-size:16px;color:#9a3412;cursor:pointer">×</button>
<div style="font-weight:700;color:#c2410c;margin-bottom:6px;padding-right:16px">⚡ Elite Apply ${mode === 'blocked' ? '— needs you' : ready ? '— ready to submit' : 'filled this form'}</div>
<div>${reason ? `${esc(reason)}<br>` : ''}Filled <b>${report.filled}</b> field${report.filled === 1 ? '' : 's'}${attached}.</div>
${todo.length ? `<div style="margin-top:6px"><b>Please answer:</b><ul style="margin:4px 0 0 16px;padding:0">${todo.slice(0, 6).map((q) => `<li>${esc(q).slice(0, 80)}</li>`).join('')}</ul></div>` : ''}
<div style="margin-top:8px;color:#6b7280">${todo.length ? 'Fill these in yourself, then press <b>Check again</b>.' : 'Review the form, then click Submit yourself.'} We'll mark it applied automatically.</div>
${bannerRecheck ? '<button data-ea="recheck" style="margin-top:10px;padding:6px 12px;border:0;border-radius:8px;background:#ea580c;color:#fff;font-weight:600;cursor:pointer">Check again</button>' : ''}`
  el.querySelector('[data-ea="close"]')?.addEventListener('click', () => el.remove())
  el.querySelector('[data-ea="recheck"]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement
    btn.disabled = true
    btn.textContent = 'Checking…'
    try { await bannerRecheck?.() } finally { if (btn.isConnected) { btn.disabled = false; btn.textContent = 'Check again' } }
  })
  document.body.appendChild(el)
}
