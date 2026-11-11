import type { StudyNextApi } from '@shared/types'

declare global {
  interface Window {
    studynext: StudyNextApi
  }
}

export {}
