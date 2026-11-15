import type { PlasmoCSConfig } from 'plasmo'
import { isVisible } from '~lib/autofill'
import { buildFillContext, getActiveJob, reportJobResult, reportProgress } from '~lib/messages'
import { runFlow } from '~lib/flow'
import { getState } from '~lib/storage'

/**
 * LinkedIn job page. Easy Apply is filled in its modal; any other "Apply"
 * opens the company's site in a new tab, which the background adopts and the
 * universal script (contents/apply.ts) fills.
 */
export const config: PlasmoCSConfig = {
  matches: ['https://www.linkedin.com/jobs/*'],
  run_at: 'document_idle',
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor<T extends Element>(find: () => T | null | undefined, timeoutMs = 12_000): Promise<T | null> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const el = find()
    if (el) return el
    await sleep(400)
  }
  return null
}

const modal = () => document.querySelector<HTMLElement>('.jobs-easy-apply-modal, [data-test-modal][role="dialog"]')
const inModal = (label: string) => modal()?.querySelector<HTMLElement>(`button[aria-label="${label}"]`)

async function main() {
  const { enabled } = await getState()
  if (!enabled) return
  const active = await getActiveJob()
  if (!active || active.phase === 'parked') return

  const applyBtn = await waitFor(() =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('button.jobs-apply-button, .jobs-apply-button--top-card button'))
      .find(isVisible),
  )
  if (!applyBtn) {
    return reportJobResult({ success: false, error: 'No Apply button — the job may be closed' })
  }

  const isEasyApply = /easy apply/i.test(applyBtn.textContent ?? '')
  applyBtn.click()

  if (!isEasyApply) {
    // External application: LinkedIn opens the company site in a new tab
    // (sometimes after a "Continue" dialog). The background follows it.
    await reportProgress('redirecting to company site')
    const cont = await waitFor(() =>
      Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find((b) => /^continue$/i.test(b.textContent?.trim() ?? '')),
      4000,
    )
    cont?.click()
    return
  }

  if (!(await waitFor(modal))) {
    return reportJobResult({ success: false, error: 'Easy Apply dialog did not open' })
  }

  await runFlow(active, buildFillContext(active), {
    root: modal,
    findSubmit: () => inModal('Submit application'),
    findNext: () => inModal('Review your application') ?? inModal('Continue to next step'),
    isConfirmation: () => /application (was )?sent|your application was submitted/i.test(document.body.innerText.slice(0, 20000)),
  })
}

main().catch((e) => reportJobResult({ success: false, needsManual: true, error: String(e?.message ?? e) }))
