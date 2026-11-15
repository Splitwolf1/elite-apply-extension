// Plasmo inlines PLASMO_PUBLIC_* env vars at build time.
declare const process: { env: Record<string, string | undefined> }
