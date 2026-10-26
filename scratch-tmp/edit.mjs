// usage: import { edit } ; applies exact-string replacements to a file regardless of CRLF/LF, preserving the original EOL
import fs from 'node:fs';
export function edit(file, pairs) {
  let s = fs.readFileSync(file, 'utf8');
  const crlf = s.includes('\r\n');
  s = s.replace(/\r\n/g, '\n');
  for (const [a, b] of pairs) {
    if (!s.includes(a)) throw new Error(`pattern not found in ${file}: ${a.slice(0, 80)}`);
    if (s.split(a).length > 2) throw new Error(`pattern not unique in ${file}: ${a.slice(0, 80)}`);
    s = s.replace(a, () => b);
  }
  if (crlf) s = s.replace(/\n/g, '\r\n');
  fs.writeFileSync(file, s);
}
