import { useEffect, useState } from 'react'
import { getState, setState } from '~lib/storage'

export default function Popup() {
  const [token, setToken] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [status, setStatus] = useState<'idle' | 'verifying' | 'ok' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')

  useEffect(() => {
    getState().then((s) => {
      setToken(s.token ?? '')
      setEnabled(s.enabled)
    })
  }, [])

  const handleSave = async () => {
    setStatus('verifying')
    setErrorMsg('')
    await setState({ token: token.trim() })

    const res = await chrome.runtime.sendMessage({ type: 'VERIFY_TOKEN' })
    if (res?.ok) {
      setStatus('ok')
    } else {
      setStatus('error')
      setErrorMsg('Token invalid or server unreachable.')
    }
  }

  const handleToggle = async () => {
    const next = !enabled
    setEnabled(next)
    await setState({ enabled: next })
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.logo}>⚡</span>
        <span style={styles.title}>Elite Apply</span>
        <button
          onClick={handleToggle}
          style={{ ...styles.toggle, background: enabled ? '#ea580c' : '#d1d5db' }}
        >
          {enabled ? 'ON' : 'OFF'}
        </button>
      </div>

      <div style={styles.body}>
        <label style={styles.label}>API Token</label>
        <input
          style={styles.input}
          type="password"
          placeholder="Paste token from Settings → Extension"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />

        <button style={styles.btn} onClick={handleSave} disabled={status === 'verifying'}>
          {status === 'verifying' ? 'Checking…' : 'Save & Verify'}
        </button>

        {status === 'ok' && <p style={styles.success}>Connected!</p>}
        {status === 'error' && <p style={styles.error}>{errorMsg}</p>}

        <p style={styles.hint}>
          Generate your token at <strong>Settings → Extension</strong> on the Elite Apply dashboard.
        </p>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: { width: 320, fontFamily: 'system-ui, sans-serif', fontSize: 13 },
  header: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '12px 16px', background: '#fff7ed', borderBottom: '1px solid #fed7aa',
  },
  logo: { fontSize: 20 },
  title: { flex: 1, fontWeight: 700, color: '#c2410c' },
  toggle: {
    border: 'none', borderRadius: 12, padding: '4px 12px',
    color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: 12,
  },
  body: { padding: 16, display: 'flex', flexDirection: 'column', gap: 10 },
  label: { fontWeight: 600, color: '#374151' },
  input: {
    border: '1px solid #d1d5db', borderRadius: 6,
    padding: '8px 10px', fontSize: 13, outline: 'none',
  },
  btn: {
    background: '#ea580c', color: '#fff', border: 'none',
    borderRadius: 6, padding: '8px 0', fontWeight: 600,
    cursor: 'pointer', fontSize: 13,
  },
  success: { color: '#15803d', margin: 0 },
  error: { color: '#dc2626', margin: 0 },
  hint: { color: '#6b7280', margin: 0, lineHeight: 1.5 },
}
