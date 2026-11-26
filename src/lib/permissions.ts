/** Optional host permissions are granted per origin from a user gesture, never in the background. */

export function originPattern(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return null;
  }
}

/** Ensures the extension may fetch these URLs. Must be called directly from a click handler. */
export async function requestOrigins(urls: string[]): Promise<boolean> {
  const origins = [...new Set(urls.map(originPattern).filter((x): x is string => Boolean(x)))];
  if (!origins.length) return true;
  const missing: string[] = [];
  for (const o of origins) {
    if (!(await chrome.permissions.contains({ origins: [o] }))) missing.push(o);
  }
  if (!missing.length) return true;
  return chrome.permissions.request({ origins: missing });
}
