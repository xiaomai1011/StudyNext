/** Pure URL guards used by the isolated Portal. */

/** URL shapes that can carry an unsaved homework editor or submission page. */
export function isProtectedWorkUrl(url: string): boolean {
  return /\/mooc2\/work\/(dowork|task|prompt)|\/work\/(dowork|task|prompt)|\/mooc2\/work\b/i.test(
    url
  )
}
