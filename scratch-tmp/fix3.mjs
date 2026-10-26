import fs from 'node:fs';
let s = fs.readFileSync('server/src/video/analysis.ts','utf8');

// per-scene focus reference + median jitter + dark suppression
s = s.replace(`export function aggregateWindows(
  series: SampleSeries,
  frameW: number,
  analyzedMs: number,
  audioDb: (number | null)[] | null,
): TechnicalWindow[] {`, `export function aggregateWindows(
  series: SampleSeries,
  frameW: number,
  analyzedMs: number,
  audioDb: (number | null)[] | null,
  sceneStartsMs: number[] = [],
): TechnicalWindow[] {`);
s = s.replace(`  // clip-level focus reference: the sharp parts of this clip
  const rawSharp = bounds.map((b) => mean(series.sharp.slice(b.from, b.to)));
  const refSharp = Math.max(percentile(rawSharp, 0.85), 1e-6);
`, `  // focus reference = the sharp parts of the SAME scene (different scenes have different amounts of detail)
  const rawSharp = bounds.map((b) => mean(series.sharp.slice(b.from, b.to)));
  const sceneOf = (startMs: number) => sceneStartsMs.filter((t) => t <= startMs + 250).length;
  const refByScene = new Map<number, number>();
  for (const sc of new Set(bounds.map((b) => sceneOf(b.startMs)))) {
    const vals = rawSharp.filter((_v, i) => sceneOf(bounds[i]!.startMs) === sc);
    refByScene.set(sc, Math.max(percentile(vals, 0.85), 1e-6));
  }
`);
s = s.replace(`    const sharpRel = clamp01(sharpRaw / refSharp);`, `    const refSharp = refByScene.get(sceneOf(b.startMs)) ?? 1e-6;
    const sharpRel = clamp01(sharpRaw / refSharp);`);
s = s.replace(`    const jitter = acc.length >= 2 ? mean(acc) / frameW : 0;`, `    // median (not mean): one wrong shift estimate must not make a steady shot look shaky
    const jitter = acc.length >= 3 ? percentile(acc, 0.5) / frameW : 0;`);
s = s.replace(`    const issues: TechIssueCode[] = [];
    if (brightness < DARK_BRIGHTNESS) issues.push('too_dark');
    if (brightness > BRIGHT_BRIGHTNESS || clipHigh > CLIPPED_HIGH_SHARE) issues.push('overexposed');
    if ((!lowDetailClip && sharpRel < BLUR_REL) || sharpRaw < BLUR_ABS) issues.push('blurry');
    if (jitter > SHAKE_JITTER) issues.push('shaky');
    if (diffs.length >= 2 && motionRaw < STATIC_MOTION) issues.push('static');
`, `    const issues: TechIssueCode[] = [];
    const dark = brightness < DARK_BRIGHTNESS;
    if (dark) issues.push('too_dark');
    if (brightness > BRIGHT_BRIGHTNESS || clipHigh > CLIPPED_HIGH_SHARE) issues.push('overexposed');
    // focus / shake / stillness cannot be judged in near-black frames: report only the exposure problem
    if (!dark && ((!lowDetailClip && sharpRel < BLUR_REL) || sharpRaw < BLUR_ABS)) issues.push('blurry');
    if (!dark && jitter > SHAKE_JITTER) issues.push('shaky');
    if (!dark && diffs.length >= 2 && motionRaw < STATIC_MOTION) issues.push('static');
`);
s = s.replace(`  const windows = aggregateWindows(series, w, analyzedMs, audioDb);

  const sceneChangesMs: number[] = [];
  series.cutAt.forEach((c, i) => {
    if (!c) return;
    const t = Math.round((i * 1000) / ANALYSIS_FPS);
    const last = sceneChangesMs[sceneChangesMs.length - 1];
    if (last === undefined || t - last >= 500) sceneChangesMs.push(t);
  });
`, `  const sceneChangesMs: number[] = [];
  series.cutAt.forEach((c, i) => {
    if (!c) return;
    const t = Math.round((i * 1000) / ANALYSIS_FPS);
    const last = sceneChangesMs[sceneChangesMs.length - 1];
    if (last === undefined || t - last >= 500) sceneChangesMs.push(t);
  });
  const windows = aggregateWindows(series, w, analyzedMs, audioDb, sceneChangesMs);
  if (process.env.AN_DEBUG) console.error('rawSharp', series.sharp.map((v) => v.toFixed(1)).join(' '));
`);
fs.writeFileSync('server/src/video/analysis.ts', s);
