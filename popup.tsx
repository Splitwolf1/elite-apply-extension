import { useEffect, useState } from 'react'
import { getState, setState } from '~lib/storage'
import type { AtsSummary, Overview } from '~lib/api'

/**
 * Three tabs:
 *   Home      on/off, what it's doing now, today's numbers, what it can do
 *   This job  autofill, ATS check with requirement flags, a cover letter
 *   Sites     where it applies, assist or auto, today's use against each cap
 * Everything it fills from (profile, answers, résumés) and the rules live on
 * the website; the popup shows them and links there.
 */

type Tab = 'home' | 'job' | 'sites'
type FillResult =
  | { kind: 'filled'; filled: number; missing?: string[]; resumeUploaded?: boolean; resumeLabel?: string }
  | { kind: 'opening' | 'login' | 'iframe' | 'none' | 'error' }
interface Runner { text: string; until: number | null; at: number }
interface Status { overview: Overview | null; runner: Runner | null; current: { title?: string; company?: string; phase: string } | null }

function describe(r: FillResult | null | undefined): { text: string; tone: 'ok' | 'warn' | 'info' } {
  if (!r) return { text: 'Could not reach this page. Reload it and try again.', tone: 'warn' }
  switch (r.kind) {
    case 'filled': {
      const attached = r.resumeUploaded ? ` and attached ${r.resumeLabel ? `“${r.resumeLabel}”` : 'your résumé'}` : ''
      const missing = r.missing?.length ? ` Still to answer: ${r.missing.slice(0, 3).join(', ')}${r.missing.length > 3 ? '…' : ''}.` : ' Review it, then click Submit yourself.'
      return { text: `Filled ${r.filled} field${r.filled === 1 ? '' : 's'}${attached}.${missing}`, tone: r.missing?.length ? 'warn' : 'ok' }
    }
    case 'opening': return { text: 'Opening the application. It fills as the form appears (sign in there if asked).', tone: 'info' }
    case 'login': return { text: 'Sign in or create your account on this site. It fills as soon as you’re in.', tone: 'info' }
    case 'iframe': return { text: 'Filling the application form on this page…', tone: 'info' }
    case 'none': return { text: 'No application form here. Open the job’s application page and try again.', tone: 'warn' }
    default: return { text: 'Something went wrong. Reload the page and try again.', tone: 'warn' }
  }
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const CAN_DO = [
  ['Applies from your queue', 'LinkedIn Easy Apply, Indeed and company sites, in this browser where you’re already signed in.'],
  ['Answers from your profile', 'Contact details, work history, screening answers. AI fills anything else from your résumé, and stops when unsure.'],
  ['Picks the right résumé', 'The one that fits each job best, in the job’s regional format.'],
  ['Writes cover letters', 'Only when a form asks for one, from your real experience.'],
  ['Checks each job', 'ATS keywords, plus red flags like “no visa sponsorship” or pay below your target.'],
  ['Hands over when it should', 'Sign-ins, CAPTCHAs and legal questions are yours. It never sees passwords.'],
]

export default function Popup() {
  const [tab, setTab] = useState<Tab>('home')
  const [enabled, setEnabled] = useState(false)
  const [apiBase, setApiBase] = useState('')
  const [resume, setResume] = useState<{ hasFile: boolean; count?: number; labels?: string[] } | null>(null)
  const [me, setMe] = useState<{ email: string | null; name: string | null } | null | undefined>(undefined) // undefined = checking
  const [status, setStatus] = useState<Status | null>(null)
  const [signingIn, setSigningIn] = useState(false)
  const [manualKey, setManualKey] = useState('')
  const [keyError, setKeyError] = useState('')
  // This job
  const [filling, setFilling] = useState(false)
  const [fillMsg, setFillMsg] = useState<{ text: string; tone: 'ok' | 'warn' | 'info' } | null>(null)
  const [checking, setChecking] = useState(false)
  const [ats, setAts] = useState<AtsSummary | null>(null)
  const [atsErr, setAtsErr] = useState('')
  const [letter, setLetter] = useState('')
  const [writing, setWriting] = useState(false)
  const [letterErr, setLetterErr] = useState('')
  const [copied, setCopied] = useState(false)

  const loadStatus = async (fresh = false) => setStatus(await chrome.runtime.sendMessage({ type: 'OVERVIEW', fresh }).catch(() => null))

  const refresh = async () => {
    const s = await getState()
    setEnabled(s.enabled)
    setApiBase(s.apiBase)
    if (!s.token) { setMe(null); setResume(null); return }
    const who = await chrome.runtime.sendMessage({ type: 'WHO_AM_I' }).catch(() => null)
    setMe(who ?? null)
    if (who) {
      chrome.runtime.sendMessage({ type: 'RESUME_STATUS' }).then(setResume).catch(() => setResume(null))
      loadStatus(true)
    }
  }

  useEffect(() => {
    refresh()
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && 'token' in changes) refresh()
      if (area === 'local' && 'runner' in changes) loadStatus()
    }
    const onFocus = () => refresh()
    chrome.storage.onChanged.addListener(onChange)
    window.addEventListener('focus', onFocus)
    return () => { chrome.storage.onChanged.removeListener(onChange); window.removeEventListener('focus', onFocus) }
  }, [])

  const open = (path: string) => chrome.tabs.create({ url: `${apiBase}${path}` })
  const signIn = () => { setSigningIn(true); chrome.tabs.create({ url: `${apiBase}/extension/connect?from=extension` }) }
  const signOut = async () => { await chrome.runtime.sendMessage({ type: 'SIGN_OUT' }); setMe(null); setResume(null); setEnabled(false) }
  const useManualKey = async () => {
    setKeyError('')
    await setState({ token: manualKey.trim() })
    const res = await chrome.runtime.sendMessage({ type: 'VERIFY_TOKEN' })
    if (res?.ok) { setManualKey(''); refresh() } else { await setState({ token: null }); setKeyError('That key was not accepted.') }
  }
  const toggle = async () => { const next = !enabled; setEnabled(next); await setState({ enabled: next }) }

  const pageText = async () => {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true })
    return t?.id ? await chrome.tabs.sendMessage(t.id, { type: 'EA_PAGE_TEXT' }).catch(() => null) as { title: string; text: string } | null : null
  }
  const autofillThisPage = async () => {
    setFilling(true); setFillMsg({ text: 'Working…', tone: 'info' })
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true })
    const res = await chrome.runtime.sendMessage({ type: 'AUTOFILL_TAB', tabId: t?.id }).catch(() => null)
    setFillMsg(res?.ok ? describe(res.result) : { text: res?.error ?? 'Could not fill this page.', tone: 'warn' })
    setFilling(false)
  }
  const checkThisJob = async () => {
    setChecking(true); setAts(null); setAtsErr('')
    try {
      const page = await pageText()
      if (!page?.text) { setAtsErr('Can’t read this page. Reload it and try again.'); return }
      const res = await chrome.runtime.sendMessage({ type: 'ATS_CHECK', jobText: `${page.title}\n${page.text}` }).catch(() => null)
      if (res?.ok) setAts(res.result); else setAtsErr(res?.error || 'The check didn’t finish. Try again.')
    } finally { setChecking(false) }
  }
  const writeLetter = async () => {
    setWriting(true); setLetter(''); setLetterErr(''); setCopied(false)
    try {
      const page = await pageText()
      if (!page?.text || page.text.length < 200) { setLetterErr('Open the job posting first, then try again.'); return }
      const res = await chrome.runtime.sendMessage({ type: 'PAGE_COVER_LETTER', title: page.title, jobText: page.text }).catch(() => null)
      if (res?.content) setLetter(res.content); else setLetterErr('Couldn’t write a letter right now. Cover letters need a paid plan.')
    } finally { setWriting(false) }
  }
  const copyLetter = async () => { try { await navigator.clipboard.writeText(letter); setCopied(true) } catch { /* blocked */ } }

  const logo = <span style={S.logo} aria-hidden="true"><svg viewBox="0 0 64 64" width="17" height="17"><path d="M16 6h22l12 12v36a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4V10a4 4 0 0 1 4-4z" fill="#fff" /><path d="M21 48L31 38L41 28" fill="none" stroke="#9fb4ff" strokeWidth="5" strokeLinecap="round" /><circle cx="21" cy="48" r="5" fill="#2f5bff" /><circle cx="31" cy="38" r="5" fill="#2f5bff" /><path d="M41 19q1 8 9 9q-8 1-9 9q-1-8-9-9q8-1 9-9z" fill="#2f5bff" /></svg></span>

  if (me === undefined) return <div style={{ ...S.container, padding: 24, textAlign: 'center', color: '#6b7280' }}>Checking…</div>

  if (me === null) {
    return (
      <div style={S.container}>
        <div style={S.header}>{logo}<span style={S.title}>Elite Apply</span></div>
        <div style={S.body}>
          <p style={{ margin: '2px 0 6px', color: '#374151' }}>Sign in to fill and track applications with your Elite Apply profile.</p>
          <button style={{ ...S.btn, padding: '10px 0' }} onClick={signIn}>{signingIn ? 'Waiting for sign-in…' : 'Sign in'}</button>
          <details style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>
            <summary style={{ cursor: 'pointer' }}>Use a key instead</summary>
            <input style={{ ...S.input, marginTop: 6, width: '100%', boxSizing: 'border-box' }} type="password" placeholder="Key from Settings → Extension" aria-label="Extension key"
              value={manualKey} onChange={(e) => setManualKey(e.target.value)} />
            <button style={{ ...S.btn, marginTop: 6, width: '100%' }} onClick={useManualKey} disabled={!manualKey.trim()}>Connect</button>
            {keyError && <p style={S.error}>{keyError}</p>}
          </details>
          <p style={S.hint}>Server: {apiBase.replace(/^https?:\/\//, '')}</p>
        </div>
      </div>
    )
  }

  const tone = { ok: '#166534', warn: '#92400e', info: '#374151' }
  const ov = status?.overview
  const runnerLine = !enabled ? 'Off. Turn it on to apply from your queue.'
    : status?.current ? `${status.current.phase === 'review' ? 'Waiting for you: ' : 'Applying: '}${[status.current.title, status.current.company].filter(Boolean).join(' at ')}`
    : status?.runner ? `${status.runner.text}${status.runner.until ? ` · until ${clock(status.runner.until)}` : ''}`
    : 'Starting…'

  return (
    <div style={S.container}>
      <div style={S.header}>
        {logo}<span style={S.title}>Elite Apply</span>
        <button onClick={toggle} role="switch" aria-checked={enabled} aria-label="Apply from my queue" title="When on, applies to jobs in your queue" style={{ ...S.toggle, background: enabled ? '#2f5bff' : '#cfd6e4' }}>{enabled ? 'ON' : 'OFF'}</button>
      </div>

      <div role="tablist" aria-label="Sections" style={S.tabs}>
        {([['home', 'Home'], ['job', 'This job'], ['sites', 'Sites']] as [Tab, string][]).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} style={{ ...S.tab, ...(tab === id ? S.tabOn : {}) }}>{label}</button>
        ))}
      </div>

      {tab === 'home' && (
        <div style={S.body}>
          <div style={S.board}>
            <span style={{ fontSize: 10, letterSpacing: '.16em', color: '#8a91a0' }}>NOW</span>
            <span style={{ fontSize: 12.5, color: enabled ? '#ffb21e' : '#c3c9d6', lineHeight: 1.4 }}>{runnerLine}</span>
            {status?.current && <button onClick={() => chrome.runtime.sendMessage({ type: 'SHOW_CURRENT' })} style={S.boardLink}>Show it</button>}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
            <Stat n={ov?.sentToday} label="Sent today" color="#08734f" bg="linear-gradient(#f1fcf6,#dbf4e8)" />
            <Stat n={ov?.inLine} label="In line" color="#1c3fd6" bg="linear-gradient(#f5f8ff,#e5ecff)" onClick={() => open('/jobs/queue')} />
            <Stat n={ov?.needsYou} label="Needs you" color="#8a5a00" bg="linear-gradient(#fffbf2,#ffefcc)" onClick={() => open('/auto-apply/needs-you')} />
          </div>

          {resume && !resume.hasFile && <button onClick={() => open('/resumes/recent')} style={S.notice}>No résumé uploaded, so nothing gets attached. <u>Add one</u></button>}

          <details style={{ fontSize: 12 }}>
            <summary style={{ cursor: 'pointer', fontWeight: 700, color: '#0b0d12' }}>What it can do</summary>
            <ul style={{ margin: '6px 0 0', padding: 0, listStyle: 'none', display: 'grid', gap: 6 }}>
              {CAN_DO.map(([h, d]) => <li key={h} style={{ lineHeight: 1.4, color: '#4a5263' }}><b style={{ color: '#0b0d12' }}>{h}.</b> {d}</li>)}
            </ul>
          </details>

          <Footer me={me} apiBase={apiBase} open={open} signOut={signOut} />
        </div>
      )}

      {tab === 'job' && (
        <div style={S.body}>
          <button style={{ ...S.btn, padding: '11px 0', fontSize: 14 }} onClick={autofillThisPage} disabled={filling}>{filling ? 'Filling…' : 'Autofill this page'}</button>
          {fillMsg && <p style={{ margin: 0, fontSize: 12, lineHeight: 1.45, color: tone[fillMsg.tone] }}>{fillMsg.text}</p>}

          <button style={S.btnLight} onClick={checkThisJob} disabled={checking}>{checking ? 'Checking this job…' : 'Check this job'}</button>
          {atsErr && <p style={{ margin: 0, fontSize: 12, color: '#92400e' }}>{atsErr}</p>}
          {ats && (
            <div style={S.atsBox}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ ...S.ring, background: `conic-gradient(${ats.score >= 75 ? '#0c9f70' : ats.score >= 50 ? '#2f5bff' : '#e8513b'} ${ats.score}%, #eaf0ff 0)` }}><b style={S.ringInner}>{ats.score}</b></span>
                <div style={{ fontSize: 12, lineHeight: 1.4, color: '#343b4c' }}>
                  <b style={{ color: '#0b0d12' }}>{ats.have.length} of {ats.have.length + ats.missing.length} keywords</b><br />
                  {ats.resumeLabel ? `vs “${ats.resumeLabel}”` : 'vs your résumé'}<br />
                  {ats.score >= 80 ? 'Strong fit: apply as is.' : ats.score >= 60 ? 'Decent fit: a tailored copy helps.' : 'Weak fit: probably skip.'}
                </div>
              </div>
              {(ats.flags?.length ?? 0) > 0 && (
                <div style={{ display: 'grid', gap: 6 }}>
                  {ats.flags!.map((f) => (
                    <div key={f.kind} style={{ display: 'grid', gap: 3 }}>
                      <span style={{ ...S.flag, background: f.blocking ? '#fdebe7' : '#fff4d9', color: f.blocking ? '#a8321e' : '#8a5a00' }}>{f.label}{f.blocking ? ' · would be held' : ''}</span>
                      <span style={{ fontSize: 11.5, lineHeight: 1.45, color: '#3a4152' }}><mark style={{ background: f.blocking ? '#ffd9d1' : '#ffeaa8', borderRadius: 3, padding: '0 2px', color: 'inherit' }}>{f.quote}</mark></span>
                    </div>
                  ))}
                </div>
              )}
              {ats.missing.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#b8321f', width: '100%' }}>MISSING KEYWORDS</span>
                  {ats.missing.slice(0, 10).map((k) => <span key={k} style={S.chipMiss}>{k}</span>)}
                </div>
              )}
              {ats.region && ats.region !== 'us' && <p style={{ margin: 0, fontSize: 11.5, color: '#4a5263' }}>Job is in {({ ca: 'Canada', uk: 'the UK or Ireland', eu: 'Europe' } as Record<string, string>)[ats.region]}: your {({ ca: 'Canadian', uk: 'UK', eu: 'European' } as Record<string, string>)[ats.region]} format is attached if you’ve made one.</p>}
              {ats.score < 80 && <a href="#" onClick={(e) => { e.preventDefault(); open('/ai-resume-scanner') }} style={S.link}>Tailor a copy for this job →</a>}
            </div>
          )}

          <button style={S.btnLight} onClick={writeLetter} disabled={writing}>{writing ? 'Writing a cover letter…' : 'Write a cover letter'}</button>
          {letterErr && <p style={{ margin: 0, fontSize: 12, color: '#92400e' }}>{letterErr}</p>}
          {letter && (
            <div style={{ display: 'grid', gap: 6 }}>
              <textarea aria-label="Cover letter" value={letter} onChange={(e) => setLetter(e.target.value)} rows={8} style={{ ...S.input, resize: 'vertical', fontSize: 12, lineHeight: 1.5, fontFamily: 'inherit' }} />
              <button style={S.btnLight} onClick={copyLetter}>{copied ? 'Copied' : 'Copy letter'}</button>
            </div>
          )}
        </div>
      )}

      {tab === 'sites' && (
        <div style={S.body}>
          {!ov ? <p style={{ margin: 0, color: '#6b7280' }}>Loading your rules…</p> : (
            <>
              <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 8 }}>
                {ov.sites.map((s) => (
                  <li key={s.id} style={{ display: 'grid', gap: 4, opacity: s.on ? 1 : 0.55 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
                      <i style={{ width: 7, height: 7, borderRadius: 9, background: s.on ? '#0c9f70' : '#cfd6e4' }} aria-hidden="true" />
                      <b style={{ flex: 1 }}>{s.label}</b>
                      <span style={{ ...S.mode, ...(s.mode === 'auto' ? { background: '#eaf0ff', color: '#1c3fd6' } : {}) }}>{s.on ? (s.mode === 'auto' ? 'Auto' : 'Assist') : 'Off'}</span>
                      <span style={{ color: '#5d6577', fontVariantNumeric: 'tabular-nums', minWidth: 38, textAlign: 'right' }}>{s.used}/{s.cap}</span>
                    </div>
                    {s.on && <span style={{ height: 4, borderRadius: 4, background: '#eef1f6' }}><span style={{ display: 'block', height: 4, borderRadius: 4, width: `${Math.min(100, (s.used / s.cap) * 100)}%`, background: s.used >= s.cap ? '#e08a00' : '#2f5bff' }} /></span>}
                  </li>
                ))}
              </ul>
              <p style={{ margin: 0, fontSize: 11.5, color: '#5d6577', lineHeight: 1.45 }}>
                <b>Assist</b> fills the form and waits for you to submit. <b>Auto</b> submits when nothing is missing.<br />
                {ov.schedule.mode === 'times' ? `Runs at ${ov.schedule.times.join(', ')}` : 'Runs whenever Chrome is open'}{ov.schedule.night ? ', overnight too.' : ', not overnight.'}
              </p>
              <button style={S.btnLight} onClick={() => open('/jobs/auto-apply')}>Change sites and rules</button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function Stat({ n, label, color, bg, onClick }: { n?: number; label: string; color: string; bg: string; onClick?: () => void }) {
  const body = <><b style={{ fontSize: 20, color: '#0b0d12', fontVariantNumeric: 'tabular-nums' }}>{n ?? '–'}</b><span style={{ fontSize: 10.5, fontWeight: 700, color }}>{label}</span></>
  const style: React.CSSProperties = { ...S.stat, background: bg, cursor: onClick ? 'pointer' : 'default' }
  return onClick ? <button onClick={onClick} style={style}>{body}</button> : <div style={style}>{body}</div>
}

function Footer({ me, apiBase, open, signOut }: { me: { email: string | null; name: string | null }; apiBase: string; open: (p: string) => void; signOut: () => void }) {
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, borderTop: '1px solid #f3f4f6', paddingTop: 8 }}>
        <a href="#" onClick={(e) => { e.preventDefault(); open('/settings') }} style={S.link}>Profile and answers</a>
        <a href="#" onClick={(e) => { e.preventDefault(); open('/jobs/queue') }} style={S.link}>Live queue</a>
        <a href="#" onClick={(e) => { e.preventDefault(); signOut() }} style={{ ...S.link, color: '#6b7280' }}>Sign out</a>
      </div>
      <p style={S.hint}>{me.email ?? me.name} · {apiBase.replace(/^https?:\/\//, '')}</p>
    </>
  )
}

const S: Record<string, React.CSSProperties> = {
  container: { width: 350, fontFamily: 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif', fontSize: 13, color: '#0b0d12', background: '#fff' },
  header: { display: 'flex', alignItems: 'center', gap: 9, padding: '12px 14px', background: '#fff', borderBottom: '1px solid #e3e8f2' },
  logo: { width: 24, height: 24, borderRadius: 7, background: '#2f5bff', display: 'grid', placeItems: 'center' },
  title: { flex: 1, fontWeight: 800, letterSpacing: '-0.02em', color: '#0b0d12', fontSize: 14.5 },
  toggle: { border: 'none', borderRadius: 999, padding: '4px 12px', color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: 11.5 },
  tabs: { display: 'flex', gap: 4, padding: '8px 14px 0', borderBottom: '1px solid #e3e8f2' },
  tab: { flex: 1, border: 'none', background: 'none', padding: '7px 0 9px', fontSize: 12.5, fontWeight: 600, color: '#5d6577', cursor: 'pointer', borderBottom: '2px solid transparent' },
  tabOn: { color: '#0b0d12', borderBottom: '2px solid #2f5bff' },
  body: { padding: 14, display: 'flex', flexDirection: 'column', gap: 10 },
  board: { display: 'grid', gap: 4, padding: '10px 12px', borderRadius: 14, background: 'linear-gradient(#15181e,#0b0d10)', fontFamily: '"JetBrains Mono", ui-monospace, monospace' },
  boardLink: { justifySelf: 'start', border: 'none', background: 'none', padding: 0, color: '#8fb0ff', fontSize: 11.5, cursor: 'pointer', fontFamily: 'inherit' },
  stat: { display: 'grid', gap: 2, justifyItems: 'start', padding: '9px 10px', borderRadius: 12, border: '1px solid rgba(255,255,255,.8)', boxShadow: 'inset 0 2px 1px rgba(255,255,255,.95), 0 8px 16px -12px rgba(11,13,18,.35)', textAlign: 'left', fontFamily: 'inherit' },
  input: { border: '1px solid #cfd6e4', borderRadius: 9, padding: '8px 10px', fontSize: 13, outline: 'none' },
  btn: { background: '#0b0d12', color: '#fff', border: 'none', borderRadius: 10, padding: '9px 0', fontWeight: 600, cursor: 'pointer', fontSize: 13 },
  btnLight: { background: '#fff', color: '#0b0d12', border: '1px solid #cfd6e4', borderRadius: 10, padding: '9px 0', fontWeight: 600, cursor: 'pointer', fontSize: 13 },
  error: { color: '#b8321f', margin: '4px 0 0' },
  hint: { color: '#8a91a0', margin: 0, fontSize: 11 },
  link: { color: '#1c3fd6', textDecoration: 'none', fontWeight: 600 },
  notice: { textAlign: 'left', fontSize: 12, padding: '8px 10px', borderRadius: 10, background: '#fff4dc', border: '1px solid #ffd78a', color: '#7a4c00', cursor: 'pointer' },
  atsBox: { display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderRadius: 14, background: 'linear-gradient(#f5f8ff, #e9efff)', boxShadow: 'inset 0 2px 1px rgba(255,255,255,.95), 0 10px 20px -16px rgba(47,91,255,.6)' },
  ring: { width: 50, height: 50, borderRadius: '50%', display: 'grid', placeItems: 'center', flex: 'none' },
  ringInner: { width: 38, height: 38, borderRadius: '50%', background: '#fff', display: 'grid', placeItems: 'center', fontSize: 15 },
  chipMiss: { background: '#ffd0dc', color: '#7a1f35', borderRadius: 999, padding: '2px 8px', fontSize: 11.5, fontWeight: 600 },
  flag: { justifySelf: 'start', borderRadius: 999, padding: '2px 8px', fontSize: 11.5, fontWeight: 700 },
  mode: { borderRadius: 999, padding: '1px 7px', fontSize: 11, fontWeight: 700, background: '#eef1f6', color: '#5d6577' },
}
