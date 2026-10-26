import { edit } from './edit.mjs';
edit('scripts/make-test-footage.ts', [
  ["  /** 0.6s 270x480 */\n  tiny: string;\n}", "  /** 0.6s 270x480 */\n  tiny: string;\n  /** 640x360 stored, 90deg rotation metadata (displays 360x640), 5s, audio */\n  rotated: string;\n}"],
  ["    tiny: p('an-tiny-270x480.mp4'),\n  };", "    tiny: p('an-tiny-270x480.mp4'),\n    rotated: p('an-rotated-90.mp4'),\n  };"],
  ["  return out;\n}\n", `  await want(out.rotated, async () => {
    const tmp = p('_an-rotated-src.mp4');
    await ff(ffmpegPath, ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=5', '-f', 'lavfi', '-i', 'sine=frequency=550:sample_rate=48000:duration=5', ...X264, '-c:a', 'aac', '-b:a', '64k', '-shortest', tmp]);
    await ff(ffmpegPath, ['-display_rotation', '270', '-i', tmp, '-c', 'copy', out.rotated]);
    await fs.rm(tmp, { force: true });
  });
  return out;
}
`],
]);
