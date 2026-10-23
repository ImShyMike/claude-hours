// The installer's files, read when the hub is built (vite.config.ts)
declare module 'virtual:installer' {
  // by the path install.sh asks for under /install/
  export const files: Record<string, string>
  export const script: string
}
