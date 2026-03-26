// Typed wrappers around chrome.storage.local

export interface ExtensionState {
  token: string | null
  enabled: boolean
  apiBase: string
  lastError: string | null
}

const DEFAULTS: ExtensionState = {
  token: null,
  enabled: false,
  apiBase: process.env.PLASMO_PUBLIC_API_BASE ?? 'https://aijobstoolkit.com',
  lastError: null,
}

export async function getState(): Promise<ExtensionState> {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULTS, (items) => {
      resolve(items as ExtensionState)
    })
  })
}

export async function setState(partial: Partial<ExtensionState>): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set(partial, resolve)
  })
}
