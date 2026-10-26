import fs from 'node:fs';
let r = fs.readFileSync('server/src/ai/rules-planner.ts','utf8');
r = r.replace("import { cleanUserLines, evenCues } from './subtitles.js';", "import { cleanUserLines, evenCues } from './subtitles.js';\nimport { fmtRange, majorIssueLabels, pickRanges } from './window-select.js';\nimport type { TechnicalProfile } from '../../../shared/analysis.js';");
r = r.replace(`  const slots: Slot[] = [];
  used.forEach((asset, i) => {
    const n = k[i]!;
    const maxLen = perExcerptMax(i);
    const len = Math.min(maxLen, Math.max(Math.min(MIN_SEG_MS, maxLen), Math.round(maxLen * factor)));
    for (let j = 0; j < n; j++) {
      const room = asset.durationMs - len;
      // single excerpt: start a little into the clip (the very first frames are often unstable); several: spread evenly
      const start = n === 1 ? Math.floor(room * 0.25) : Math.floor((room * j) / (n - 1));
      slots.push({ asset, maxLen, start, len });
    }
  });
`, `  // technical measurements (local signal analysis, no AI), keyed by asset
  const tech = new Map<string, TechnicalProfile>();
  for (const a of input.clipAnalyses ?? []) if (a.source === 'technical' && a.technical && a.technical.windows.length > 0) tech.set(a.assetId, a.technical);

  const slots: Slot[] = [];
  let measuredClips = 0;
  used.forEach((asset, i) => {
    const n = k[i]!;
    const maxLen = perExcerptMax(i);
    const len = Math.min(maxLen, Math.max(Math.min(MIN_SEG_MS, maxLen), Math.round(maxLen * factor)));
    const profile = tech.get(asset.id);
    const picks = profile ? pickRanges(profile, len, n, input.preset) : [];
    if (profile && picks.length === n) {
      measuredClips++;
      for (const pk of picks) slots.push({ asset, maxLen, start: pk.startMs, len: pk.endMs - pk.startMs });
      const skipped = profile.issues.filter((x) => x.code !== 'silent_audio' && x.share < 1 && x.ranges.some((rg) => picks.every((pk) => rg.endMs <= pk.startMs || rg.startMs >= pk.endMs)));
      if (skipped.length > 0) {
        notes.push(\`"\${asset.name}": used \${picks.map((pk) => fmtRange(pk.startMs, pk.endMs)).join(', ')}, avoiding parts measured as \${skipped.map((x) => x.label.replace(/ \(.*\)/, '')).join(' / ')}.\`);
      }
      const bad = majorIssueLabels(profile);
      if (bad.length > 0) notes.push(\`"\${asset.name}" measures as \${bad.join(' / ')} for most of its length; it is still included because the Basic auto-edit keeps your clips.\`);
      return;
    }
    for (let j = 0; j < n; j++) {
      const room = asset.durationMs - len;
      // single excerpt: start a little into the clip (the very first frames are often unstable); several: spread evenly
      const start = n === 1 ? Math.floor(room * 0.25) : Math.floor((room * j) / (n - 1));
      slots.push({ asset, maxLen, start, len });
    }
  });
  if (measuredClips > 0) {
    notes.push(\`Trim points for \${measuredClips} of \${used.length} clip(s) were chosen from local signal measurements (exposure, sharpness, steadiness, scene cuts). The Basic auto-edit still does not know what is in the shots.\`);
  }
`);
r = r.replace("It cannot read your brief or see the footage, so trim points are chosen by clip length only.`,", "It cannot read your brief or see the footage, so ${measuredClips > 0 ? 'trim points favour technically strong moments (well exposed, sharp, steady, not crossing a scene change) and it does not know what is in them' : 'trim points are chosen by clip length only'}.`,");
fs.writeFileSync('server/src/ai/rules-planner.ts', r);
