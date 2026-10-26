import { useEffect, useMemo, useState } from 'react';
import type { ProjectDTO } from '@shared/api';
import type { OutputFormat, StylePreset } from '@shared/editPlan';
import { api } from '../../api/client';
import { Button, Callout, Textarea } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { FORMAT_OPTIONS, STYLE_OPTIONS } from '../../lib/format';

const MAX_LINE = 160;

const toLines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

export function BriefStep({
  project,
  includedVideos,
  hasVersions,
  active,
  onSaved,
  onCreateDraft,
  creating,
}: {
  project: ProjectDTO;
  includedVideos: number;
  hasVersions: boolean;
  active: boolean;
  onSaved: () => Promise<void> | void;
  onCreateDraft: (instruction: string) => Promise<void>;
  creating: boolean;
}) {
  const toast = useToast();
  const [brief, setBrief] = useState(project.brief);
  const [style, setStyle] = useState<StylePreset>(project.stylePreset);
  const [format, setFormat] = useState<OutputFormat>(project.format);
  const [subs, setSubs] = useState(project.subtitleLines.join('\n'));
  const [saving, setSaving] = useState(false);

  // Re-sync when the project changes underneath us (e.g. after a save) but never clobber unsaved edits.
  const serverKey = JSON.stringify([project.brief, project.stylePreset, project.format, project.subtitleLines]);
  const [syncedKey, setSyncedKey] = useState(serverKey);
  const dirty = useMemo(
    () => brief !== project.brief || style !== project.stylePreset || format !== project.format || JSON.stringify(toLines(subs)) !== JSON.stringify(project.subtitleLines),
    [brief, style, format, subs, project],
  );
  useEffect(() => {
    if (serverKey !== syncedKey) {
      setSyncedKey(serverKey);
      if (!dirty) {
        setBrief(project.brief);
        setStyle(project.stylePreset);
        setFormat(project.format);
        setSubs(project.subtitleLines.join('\n'));
      }
    }
  }, [serverKey, syncedKey, dirty, project]);

  const lines = toLines(subs);
  const longLine = lines.findIndex((l) => l.length > MAX_LINE);
  const subsError = longLine >= 0 ? `Line ${longLine + 1} is ${lines[longLine]!.length} characters; the limit is ${MAX_LINE}.` : lines.length > 200 ? 'At most 200 lines.' : undefined;
  const archived = project.status === 'archived';

  const save = async (): Promise<boolean> => {
    if (subsError) return false;
    setSaving(true);
    try {
      await api.projects.patch(project.id, { brief, stylePreset: style, format, subtitleLines: lines });
      await onSaved();
      return true;
    } catch (e) {
      toast.error(e, 'Could not save the brief');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const createDraft = async () => {
    if (dirty && !(await save())) return;
    await onCreateDraft(brief.trim());
  };

  const cannotCreate = includedVideos === 0 ? 'Add and include at least one video clip first.' : archived ? 'Unarchive the project first.' : active ? 'A draft is already being produced.' : null;

  return (
    <div className="stack-l">
      <section className="card" aria-labelledby="brief-h">
        <div className="card-head">
          <Icon name="edit" className="faint" />
          <h2 id="brief-h">Your brief</h2>
        </div>
        <div className="card-body stack">
          <Textarea
            label="What should this video be?"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            rows={6}
            maxLength={5000}
            placeholder="e.g. A calm morning routine, slow cuts, ending on the sunrise shot. Open with the title “Slow mornings”."
            hint="Describe the mood, pacing and order in plain language. Tip: put any on-screen title text in “quotes”. Leave it empty for a basic auto-edit."
          />

          <fieldset className="fieldset">
            <legend>Style</legend>
            <div className="choice-grid" role="radiogroup" aria-label="Style preset">
              {STYLE_OPTIONS.map((s) => (
                <label key={s.id} className={`choice${style === s.id ? ' choice-on' : ''}`}>
                  <input type="radio" name="style" value={s.id} checked={style === s.id} onChange={() => setStyle(s.id)} />
                  <span className="choice-title">{s.label}</span>
                  <span className="choice-blurb">{s.blurb}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="fieldset">
            <legend>Output format</legend>
            <div className="choice-grid choice-grid-3" role="radiogroup" aria-label="Output format">
              {FORMAT_OPTIONS.map((f) => (
                <label key={f.id} className={`choice${format === f.id ? ' choice-on' : ''}`}>
                  <input type="radio" name="format" value={f.id} checked={format === f.id} onChange={() => setFormat(f.id)} />
                  <span className="choice-title">{f.label}</span>
                  <span className="choice-blurb">{f.blurb}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <Textarea
            label="Subtitle lines"
            optional
            value={subs}
            onChange={(e) => setSubs(e.target.value)}
            rows={5}
            placeholder={'One line of text per line.\nEach becomes a subtitle.'}
            error={subsError}
            hint="Subtitles are only ever the text you type here. Amir SM does not listen to your audio, so there is no automatic transcription and nothing is invented. Lines are placed along the video’s timeline for you to check; they are not synced to speech."
          />
          {lines.length ? <div className="tiny muted">{lines.length} subtitle {lines.length === 1 ? 'line' : 'lines'}</div> : null}
        </div>
      </section>

      <div className="actionbar">
        <Button onClick={() => void save()} busy={saving} disabled={!dirty || !!subsError || creating}>
          {dirty ? 'Save brief' : 'Brief saved'}
        </Button>
        <span className="spacer" />
        {hasVersions ? (
          <span className="small muted" style={{ maxWidth: '46ch' }}>
            To change an existing draft, use <strong>Revise</strong> on the review step. The brief applies to a first draft.
          </span>
        ) : (
          <Button variant="primary" size="lg" icon="play" onClick={() => void createDraft()} busy={creating || saving} disabled={!!cannotCreate || !!subsError} title={cannotCreate ?? undefined}>
            Create draft
          </Button>
        )}
      </div>
      {!hasVersions && cannotCreate ? <Callout tone="info">{cannotCreate}</Callout> : null}
    </div>
  );
}
