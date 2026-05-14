/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_COGNITO_DOMAIN?: string;
  readonly VITE_ARREARS_COGNITO_CLIENT_ID?: string;
  readonly VITE_COGNITO_REDIRECT_URI?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
