/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string
  /** ICP 备案号，如：粤ICP备xxxxxxxx号；设后显示在页脚并链至 beian.miit.gov.cn */
  readonly VITE_ICP_BEIAN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
