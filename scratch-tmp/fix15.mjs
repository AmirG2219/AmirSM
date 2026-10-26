import { edit } from './edit.mjs';
edit('server/test/ai/vision.test.ts', [
  [`  it('the underlying runtime error really is an AiOutputError', async () => {
    // same path through callStructured, asserted at the error type level
    const bad = toolUse('submit_clip_analyses', { nope: true });
    const client = new FakeClient([bad, bad]);
    const svc = createAiService({ config: makeConfig(), usage: new MemoryUsageStore(), client, sleep: noSleep });
    const res = await svc.analyzeClips({ projectId: 'p', clips: [clip(1)], getFrames: async () => frames(5000, 4) });
    expect(res.skipped[0]!.reason).not.toBe('');
    expect(new AiOutputError('x')).toBeInstanceOf(Error);
  });`,
`  it('the underlying runtime error really is an AiOutputError (callStructured with the vision schema)', async () => {
    const bad = toolUse('submit_clip_analyses', { nope: true });
    const rt = new AiRuntime({ config: makeConfig(), usage: new MemoryUsageStore(), client: new FakeClient([bad, bad]), sleep: noSleep });
    await expect(
      rt.callStructured({ role: 'vision', model: 'm', system: 's', user: '', userContent: [{ type: 'text', text: 'x' }], toolName: 'submit_clip_analyses', toolDescription: 'd', zodSchema: VisionToolSchema, jsonSchema: visionToolJsonSchema(), maxTokens: 1000 }),
    ).rejects.toBeInstanceOf(AiOutputError);
  });`],
  ["import { createAiService, AiOutputError } from '../../src/ai/index.js';", "import { createAiService, AiOutputError } from '../../src/ai/index.js';\nimport { AiRuntime } from '../../src/ai/client.js';"],
  ["  sanitizeVisualClip,\n  stripAudioClaims,\n  visionSystemPrompt,\n}", "  sanitizeVisualClip,\n  stripAudioClaims,\n  visionSystemPrompt,\n  VisionToolSchema,\n  visionToolJsonSchema,\n}"],
]);
