/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_WHEREAS_DEMO_MODE?: string;
  readonly VITE_NANGO_PUBLIC_URL?: string;
  readonly VITE_DOCUSEAL_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
