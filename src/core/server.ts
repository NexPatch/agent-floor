const params = new URLSearchParams(location.search);

/** Where the floor server lives. Same origin by default; `?server=` overrides. */
export function serverBase() {
  const explicit = params.get('server');
  if (explicit) return explicit.replace(/\/$/, '');
  return '';
}

/** The picture posted for an agent; the hash in `?v=` changes when the picture does. */
export function avatarUrl(agentId: string, hash: string) {
  return `${serverBase()}/avatars/${encodeURIComponent(agentId)}?v=${encodeURIComponent(hash)}`;
}
