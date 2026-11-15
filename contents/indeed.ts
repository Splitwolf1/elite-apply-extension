import type { PlasmoCSConfig } from 'plasmo'
import { isVisible } from '~lib/autofill'
import { getActiveJob, reportJobResult, reportProgress } from '~lib/messages'
import { getState } from '~lib/storage'

/**
 * Indeed job page: click the apply button. "Apply now" continues on
 * smartapply.indeed.com and "Apply on company site" opens the employer's site;
 * both are filled by the universal script (contents/apply.ts).
 */
export const config: PlasmoCSConfig = {
  matches: ['https://www.indeed.com/*'],
  run_at: 'document_idle',
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const { enabled } = await getState()
  if (!enabled) return
  const active = await getActiveJob()
  if (!active) return

  let btn: HTMLElement | undefined
  for (let i = 0; i < 25 && !btn; i++) {
    btn = Array.from(document.querySelectorAll<HTMLElement>(
      '#indeedApplyButton, [data-testid="indeedApplyButton"], .ia-IndeedApplyButton, button, a',
    )).find((b) => isVisible(b) && /^(apply now|apply on company site|easily apply)$/i.test(b.textContent?.trim() ?? ''))
    if (!btn) await sleep(400)
  }
  if (!btn) return reportJobResult({ success: false, error: 'No Apply button — the job may be closed' })

  await reportProgress('opening Indeed application')
  btn.click()
}

main().catch((e) => reportJobResult({ success: false, needsManual: true, error: String(e?.message ?? e) }))
