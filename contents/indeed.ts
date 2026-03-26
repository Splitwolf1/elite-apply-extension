import type { PlasmoCSConfig } from 'plasmo'
import { getState } from '~lib/storage'
import { getAnswer, getResume, reportResult } from '~lib/api'

export const config: PlasmoCSConfig = {
  matches: ['https://www.indeed.com/*'],
  run_at: 'document_idle',
}

function waitFor(selector: string, timeoutMs = 10_000): Promise<Element | null> {
  return new Promise((resolve) => {
    const el = document.querySelector(selector)
    if (el) return resolve(el)
    const observer = new MutationObserver(() => {
      const found = document.querySelector(selector)
      if (found) { observer.disconnect(); resolve(found) }
    })
    observer.observe(document.body, { childList: true, subtree: true })
    setTimeout(() => { observer.disconnect(); resolve(null) }, timeoutMs)
  })
}

async function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  el.focus()
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

async function fillIndeedApply(job: { queueId: string; jobUrl: string; profile: any }) {
  const { profile } = job
  let page = 0
  const MAX_PAGES = 15

  while (page++ < MAX_PAGES) {
    await new Promise(r => setTimeout(r, 1000))

    const inputs = document.querySelectorAll<HTMLInputElement>(
      'input[type=text],input[type=email],input[type=tel],textarea'
    )
    for (const input of inputs) {
      if (input.value) continue
      const label = (
        document.querySelector(`label[for="${input.id}"]`)?.textContent ??
        input.placeholder ??
        input.name ??
        ''
      ).toLowerCase()

      if (label.includes('first')) await typeInto(input, profile.firstName)
      else if (label.includes('last')) await typeInto(input, profile.lastName)
      else if (label.includes('email')) await typeInto(input, profile.email)
      else if (label.includes('phone')) await typeInto(input, profile.phone)
      else if (label.includes('city') || label.includes('location')) await typeInto(input, profile.location)
      else {
        const answer = await getAnswer(label, JSON.stringify(profile)).catch(() => '')
        if (answer) await typeInto(input, answer)
      }
    }

    // File upload
    const fileInput = document.querySelector<HTMLInputElement>('input[type=file]')
    if (fileInput) {
      const resumeData = await getResume().catch(() => null)
      if (resumeData?.url) {
        try {
          const blob = await fetch(resumeData.url).then(r => r.blob())
          const file = new File([blob], 'resume.pdf', { type: 'application/pdf' })
          const dt = new DataTransfer()
          dt.items.add(file)
          fileInput.files = dt.files
          fileInput.dispatchEvent(new Event('change', { bubbles: true }))
        } catch { /* skip */ }
      }
    }

    // Look for submit / continue
    const allBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    const submitBtn = allBtns.find(b => /submit|apply now/i.test(b.textContent ?? ''))
    const nextBtn   = allBtns.find(b => /continue|next/i.test(b.textContent ?? ''))

    if (submitBtn && !submitBtn.disabled) {
      submitBtn.click()
      await new Promise(r => setTimeout(r, 2000))
      return { success: true, confirmationText: 'Applied via Indeed Quick Apply' }
    }

    if (nextBtn && !nextBtn.disabled) {
      nextBtn.click()
      continue
    }

    break
  }

  return { success: false, error: 'Could not complete Indeed apply flow' }
}

;(async () => {
  const { enabled } = await getState()
  if (!enabled) return

  const job = await chrome.runtime.sendMessage({ type: 'GET_ACTIVE_JOB' })
  if (!job || !job.jobUrl.includes('indeed.com')) return

  const applyBtn = await waitFor('[data-testid="apply-button-linkless"], .ia-IndeedApplyButton')
  if (!applyBtn) return
  ;(applyBtn as HTMLButtonElement).click()
  await new Promise(r => setTimeout(r, 2000))

  const result = await fillIndeedApply(job).catch((err) => ({
    success: false,
    error: err.message,
  }))

  await reportResult({
    queueId: job.queueId,
    jobUrl: job.jobUrl,
    status: result.success ? 'applied' : 'failed',
    error: result.success ? undefined : result.error,
    confirmationText: result.success ? result.confirmationText : undefined,
  })

  await chrome.runtime.sendMessage({ type: 'CLEAR_ACTIVE_JOB' })

  if (result.success) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'assets/icon128.png',
      title: 'Elite Apply',
      message: 'Applied successfully via Indeed!',
    })
    window.close()
  }
})()
