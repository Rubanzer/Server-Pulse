/**
 * Full page load after the login state changes (log in, sign up, connect, log out, delete account).
 * The client router may hold prefetches made under the old session (e.g. "/" → redirect to /login),
 * and router.replace would reuse them.
 */
export function hardNavigate(path: string) {
  window.location.assign(path);
}

/** The session ended (401): log in again and come back to this exact page. */
export function toLogin() {
  hardNavigate(
    `/login?next=${encodeURIComponent(location.pathname + location.search)}`,
  );
}
