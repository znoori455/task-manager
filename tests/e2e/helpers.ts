/**
 * Cookie for a fresh setup user per test. Project creation is rate limited per
 * user (burst of 5), so a single shared setup user would hit 429s.
 */
export function setupHeaders() {
  return { cookie: `tf_user=setup-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` };
}
