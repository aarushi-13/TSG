/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SIGNALING_URL?: string
  readonly VITE_ICE_SERVERS?: string
  readonly VITE_STUN_URLS?: string
  readonly VITE_SUMMARY_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
