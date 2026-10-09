/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DASHBOARD_PIN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
