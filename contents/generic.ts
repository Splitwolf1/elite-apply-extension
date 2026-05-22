import type { PlasmoCSConfig } from 'plasmo'
import { getState } from '~lib/storage'
import { getAnswer, getResume } from '~lib/api'

export const config: PlasmoCSConfig = {
  // Catch-all for any job page that isn't LinkedIn/Indeed
  matches: [
    'https://*.greenhouse.io/*',
    'https://*.lever.co/*',
    'https://*.myworkdayjobs.com/*',
    'https://*.jobvite.com/*',
    'https://*.icims.com/*',
  ],
  run_at: 'document_idle',
}

async function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  el.focus()
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

function getLabelText(input: HTMLInputElement | HTMLTextAreaElement): string {
  if (input.labels?.[0]) return input.labels[0].textContent ?? ''
  const id = input.id
  if (id) {
    const label = document.querySelector(`label[for="${id}"]`)
    if (label) return label.textContent ?? ''
  }
  // Walk up for wrapping label
  let parent = input.parentElement
  while (parent) {
    if (parent.tagName === 'LABEL') return parent.textContent ?? ''
    const lbl = parent.querySelector('label')
    if (lbl) return lbl.textContent ?? ''
    parent = parent.parentElement
  }
  return input.placeholder ?? input.name ?? ''
}

async function fillGenericForm(job: { queueId: string; jobUrl: string; profile: any }) {
  const { profile } = job
  let page = 0
  const MAX_PAGES = 20

  while (page++ < MAX_PAGES) {
    await new Promise(r => setTimeout(r, 1200))

    const inputs = document.querySelectorAll<HTMLInputElement>(
      'input[type=text],input[type=email],input[type=tel],input[type=url],textarea'
    )
    for (const input of inputs) {
      if (input.value || input.disabled || input.readOnly) continue
      const labelRaw = getLabelText(input).toLowerCase().trim()

      if (!labelRaw) continue

      if (/first.?name/.test(labelRaw)) await typeInto(input, profile.firstName)
      else if (/last.?name/.test(labelRaw)) await typeInto(input, profile.lastName)
      else if (/email/.test(labelRaw)) await typeInto(input, profile.email)
      else if (/phone|mobile/.test(labelRaw)) await typeInto(input, profile.phone)
      else if (/city|location|address/.test(labelRaw)) await typeInto(input, profile.location)
      else if (/linkedin/.test(labelRaw)) await typeInto(input, profile.linkedinUrl ?? '')
      else if (/github/.test(labelRaw)) await typeInto(input, profile.githubUrl ?? '')
      else if (/portfolio|website|url/.test(labelRaw)) await typeInto(input, profile.portfolioUrl ?? profile.websiteUrl ?? '')
      else {
        const answer = await getAnswer(labelRaw, JSON.stringify({
          title: profile.professionalTitle,
          bio: profile.bio?.slice(0, 200),
          location: profile.location,
        })).catch(() => '')
        if (answer) await typeInto(input, answer)
      }
    }

    // Work authorization selects
    const selects = document.querySelectorAll<HTMLSelectElement>('select')
    for (const sel of selects) {
      const labelRaw = getLabelText(sel as any).toLowerCase()
      if (/authorized|work.?permit|visa|sponsorship/.test(labelRaw)) {
        // Try to pick "Yes" / "No sponsor"
        for (const opt of sel.options) {
          const v = opt.text.toLowerCase()
          if (/^yes/.test(v) && /authorized|permit/.test(labelRaw)) {
            sel.value = opt.value
            sel.dispatchEvent(new Event('change', { bubbles: true }))
            break
          }
          if (/^no/.test(v) && /sponsor/.test(labelRaw)) {
            sel.value = opt.value
            sel.dispatchEvent(new Event('change', { bubbles: true }))
            break
          }
        }
      }
    }

    // Resume upload
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

    const allBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('button,input[type=submit]'))
    const submitBtn = allBtns.find(b => /submit|send.?app|apply/i.test(b.textContent ?? (b as HTMLInputElement).value ?? ''))
    const nextBtn   = allBtns.find(b => /^(next|continue|proceed)$/i.test((b.textContent ?? '').trim()))

    if (submitBtn && !submitBtn.disabled) {
      submitBtn.click()
      await new Promise(r => setTimeout(r, 3000))
      // Check for confirmation
      const body = document.body.innerText.toLowerCase()
      if (body.includes('thank') || body.includes('submitted') || body.includes('confirmation')) {
        return { success: true, confirmationText: 'Application submitted' }
      }
      return { success: false, error: 'Submit clicked but no confirmation detected' }
    }

    if (nextBtn && !nextBtn.disabled) {
      nextBtn.click()
      continue
    }

    break
  }

  return { success: false, error: 'Could not complete generic form' }
}

;(async () => {
  const { enabled } = await getState()
  if (!enabled) return

  const job = await chrome.runtime.sendMessage({ type: 'GET_ACTIVE_JOB' })
  if (!job) return

  const result = await fillGenericForm(job).catch((err) => ({
    success: false as const,
    error: err.message as string,
    confirmationText: undefined as string | undefined,
  }))

  // Signal background — it owns reporting, notification, and window cleanup
  chrome.runtime.sendMessage({ type: 'JOB_RESULT', result })
})()
