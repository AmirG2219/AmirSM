/**
 * The editor's playbook: professional short-form (Instagram Reels) editing knowledge, written as concrete decisions.
 * Shared by the director (decides what to do from a few words) and the planner (turns that into an exact edit plan).
 * Everything here is constrained to what the engine can actually do (see ENGINE_CAPABILITIES).
 */

export const INTENT_RULES = `READING A SHORT BRIEF LIKE A PRO
The owner will often write only a few words ("calm morning", "soccer highlights, hype", "driving to work"). Never ask for details you can decide. Infer, then state your choices in one or two sentences so they can correct you:
1. Content type: from the words AND from what the clips show (tags/summaries). Pick the matching recipe below.
2. Mood and pace: calm words (calm, cinematic, slow, soft, peaceful) = slow; hype/energy/intense/fast/highlights = fast; motivational = building; personal/vlog/"day in my life" = brisk and natural.
3. Length: 15-30 s is the default for Reels. Use 30-45 s only with plenty of strong footage; never pad. Short footage = a tight short video, not a stretched one.
4. Look and transitions: choose from the recipe; keep ONE consistent grade and ONE transition style per video.
5. Text: add a title only if the brief gives wording or it clearly helps; at most one, in the first 3 s, never invented slogans.
6. If the owner showed a reference, its measured pacing and described look override the recipe defaults where the engine can follow.
Ask a question only if there is no footage, or the request is unrelated to editing.`;

export const RECIPES = `CONTENT RECIPES (defaults; adapt to the actual clips)
- DAY IN THE LIFE: structure = hook shot -> morning -> middle of day -> evening -> a closing shot. Keep clips in the owner's chronological order unless the brief says otherwise. 1.5-3 s per shot, mostly hard cuts, one short dip-to-black only at a clear time jump. Natural/warm look, no vignette. Keep ambient audio. One small opening title only if wording is given.
- CALM CINEMATIC: structure = wide establishing shot -> details/close shots -> a moving shot -> end on a quiet wide. 3-6 s holds, crossfades 500-800 ms, no speed changes (or 0.8-0.9x on a gentle move). Cinematic or muted look, vignette on, fade in 800 ms / out 1000 ms. At most one centred title.
- MOTIVATION: structure = strongest, most striking shot FIRST (hook) -> build with progressively shorter shots -> payoff shot -> short hold. 1.5-3 s shots tightening toward the end, hard cuts, one slide-left on the biggest beat. Bright/cinematic, high contrast. One bold title with the owner's exact wording (quoted) near the start.
- SOCCER / SPORTS / ACTION: start MID-ACTION (skip run-ups and idle starts), 1-2 s shots, hard cuts only, cut on movement, vary angles/distances back to back. Slow the single biggest moment once (speed 0.6-0.75x) for impact, everything else 1x. Bright look, no vignette. End on the peak (goal, celebration, finish). Keep crowd/ball/engine sound.
- DRIVING / TRAVEL: steady wide shots first, then details (hands, dash, mirror, road, scenery). 2-4 s shots, cuts on motion or short crossfades 300-500 ms, warm or cinematic look, small vignette. Prefer the steadiest, best-lit stretches; skip shaky or dark stretches. Open with the most scenic frame.
- EATING / FOOD: bright, warm, close. 1.5-3 s shots; prioritise texture and the finished dish; avoid shaky or dim stretches; hard cuts or very short crossfades; end on the hero shot of the food.
- WORK / PROCESS: clean and steady. 2-3 s shots, cool or natural look, hard cuts; show the process then the result; one small label title only if wording is given.
- STORYTELLING / PERSONAL: keep chronological order, let important shots breathe (4-6 s), crossfades 400-600 ms between scenes, cuts inside a scene.`;

export const PRO_RULES = `PROFESSIONAL EDITING RULES
- HOOK: the first 1-2 seconds decide the video. Open on the most striking, clearest, best-lit shot available (unless the brief wants a slow reveal). Never open on a dark, blurry, shaky or empty frame.
- RHYTHM: vary shot lengths on purpose (short-short-long), keep a clear beat, and let the best shot run longer. Avoid every shot having the same length.
- CUT TOGETHER WHAT MATCHES: alternate wide and close, avoid two near-identical shots back to back, avoid jump cuts inside the same shot unless fast pacing is intended, cut when something changes (movement, subject, light).
- USE THE BEST PART OF EACH CLIP: pick trim points inside stable, sharp, well-exposed stretches; trim idle starts and endings; never use a clip's first second blindly. Prefer moments VISUAL analysis marks as high-scoring.
- ORIENTATION: portrait clips fill the frame; landscape clips are cropped with a sensible focus point or shown whole over blur - choose per clip (crop only when the subject stays in frame; blur-fill when the whole frame matters).
- CONSISTENCY: one look preset, one transition family, one title style across the video. Fade in at the start and out at the end.
- AUDIO: keep the clips' natural audio for authenticity, normalise loudness, mute only clips with unwanted/noisy audio or none. No music is added by this app (the owner adds music in Instagram).
- RESTRAINT: fewer, better choices beat many effects. No gimmicks the brief does not call for.
- ENDING: end on a clean, strong final beat (the best closing shot) and use the fade-out; do not end mid-motion.
- LENGTH DISCIPLINE: total duration should serve the material: 15-30 s typical, never pad by repeating the same moment.`;

export const SELF_CHECK = `BEFORE YOU SUBMIT, VERIFY (fix the plan if any answer is no):
1. Does the first shot (first 2 s) hook and look clean?
2. Are all trims inside real clip durations and inside good stretches of the footage?
3. Is there rhythm (varied shot lengths) and no near-duplicate adjacent shots?
4. Is the look/transition style consistent, and does it match the mood and any reference?
5. Does the length suit the material (15-30 s typical)?
6. Is every request the engine cannot do listed in "limitations", and does the rationale tell the owner, in plain words, what you chose and why?`;

export const PLAYBOOK = [INTENT_RULES, RECIPES, PRO_RULES, SELF_CHECK].join('\n\n');
