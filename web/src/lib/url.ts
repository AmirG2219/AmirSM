/** Return the URL only if it is a plain http(s) link; anything else (javascript:, data:, …) becomes null. */
export function safeHttpUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:' ? p.toString() : null;
  } catch {
    return null;
  }
}

export function hostOf(u: string): string {
  try {
    return new URL(u).host.replace(/^www\./, '');
  } catch {
    return u;
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
