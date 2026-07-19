import * as ReactNamespace from 'react'

declare global {
  const fetch: (input: string | Request, init?: RequestInit) => Promise<Response>
  const modifiers: () => any
  const Dialog: {
    alert: (options: { message: string; title?: string; buttonLabel?: string }) => Promise<void>
    confirm: (options: { message: string; title?: string; cancelLabel?: string; confirmLabel?: string }) => Promise<boolean>
    prompt: (options: any) => Promise<string | null>
    actionSheet: (options: any) => Promise<number | null>
  }
  const btoa: (str: string) => string
  const atob: (str: string) => string
}

declare module 'react' {
  export = ReactNamespace
}
