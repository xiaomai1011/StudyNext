export class UserFacingError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'UserFacingError'
    this.code = code
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof UserFacingError) return error.message
  if (error instanceof Error) return error.message
  return '发生未知错误'
}

export function toUserFacingError(error: unknown): UserFacingError {
  if (error instanceof UserFacingError) return error
  return new UserFacingError('UNEXPECTED', errorMessage(error))
}
