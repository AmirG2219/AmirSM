import { useMemo, useState, type FormEvent } from 'react';
import type { CompetitorDTO, ResearchCapabilities, ResearchNoteDTO, ResearchRunDTO } from '@shared/api';
import { api, type CompetitorAnalysis, type MarketResearchResult } from '../api/client';
import { Badge, Button, Callout, Card, CardHeader, EmptyState, Input, PageHeader, Select, Skeleton, Tabs, Textarea } from '../components/ui';
import { Icon } from '../components/Icon';
import { ExternalLink } from '../components/ExternalLink';
import { Modal } from '../components/Modal';
import { useToast } from '../components/Toast';
import { useAsync, useDebounced, useDocumentTitle } from '../hooks/hooks';
import { relativeTime } from '../lib/format';
import { safeHttpUrl } from '../lib/url';

type Tab = 'competitors' | 'notes' | 'market' | 'history';

export function Research() {
  useDocumentTitle('Research');
  const [tab, setTab] = useState<Tab>('competitors');
  const caps = useAsync((s) => api.research.capabilities(s), []);
  const competitors = useAsync((s) => api.research.competitors(s), []);
  const runs = useAsync((s) => api.research.runs(s), []);

  return (
    <div className="page">
      <PageHeader title="Research" lede="Keep track of competitors, collect ideas, and analyse material you paste in." />

      <Callout tone="info" title="Nothing is scraped from social platforms">
        Amir SM does not connect to Instagram, TikTok, YouTube or any other platform, and it does not browse them. Competitor analysis reads <strong>only the text you paste in</strong> yourself. Market research runs only if a web-search source is connected (see its tab).
      </Callout>

      <div style={{ height: 'var(--s-5)' }} />
      <Tabs
        idPrefix="res"
        label="Research sections"
        value={tab}
        onChange={setTab}
        items={[
          { id: 'competitors', label: 'Competitors' },
          { id: 'notes', label: 'Notes' },
          { id: 'market', label: 'Market research' },
          { id: 'history', label: 'History' },
        ]}
      />
      <div style={{ height: 'var(--s-5)' }} />

      <div role="tabpanel" id="res-panel-competitors" aria-labelledby="res-tab-competitors" hidden={tab !== 'competitors'}>
        <CompetitorsTab competitors={competitors} runs={runs.data ?? []} caps={caps.data} onRunSaved={runs.reload} />
      </div>
      <div role="tabpanel" id="res-panel-notes" aria-labelledby="res-tab-notes" hidden={tab !== 'notes'}>
        <NotesTab competitors={competitors.data ?? []} />
      </div>
      <div role="tabpanel" id="res-panel-market" aria-labelledby="res-tab-market" hidden={tab !== 'market'}>
        <MarketTab caps={caps.data} capsError={caps.error?.message} onRunSaved={runs.reload} />
      </div>
      <div role="tabpanel" id="res-panel-history" aria-labelledby="res-tab-history" hidden={tab !== 'history'}>
        <HistoryTab runs={runs} />
      </div>
    </div>
  );
}

/* ---------- Result renderers ---------- */
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

function List({ items, empty }: { items: string[]; empty: string }) {
  return items.length ? (
    <ul className="bullets">
      {items.map((x, i) => (
        <li key={i}>{x}</li>
      ))}
    </ul>
  ) : (
    <p className="small muted">{empty}</p>
  );
}

export function CompetitorResult({ result }: { result: unknown }) {
  const r = result as Partial<CompetitorAnalysis> | null;
  if (!r || typeof r.summary !== 'string') return <p className="small muted">This result has an unexpected format and cannot be shown.</p>;
  return (
    <div className="stack result">
      <div>
        <div className="eyebrow">Summary</div>
        <p style={{ marginTop: 4 }}>{r.summary}</p>
      </div>
      <div>
        <div className="eyebrow">Patterns across the material</div>
        <List items={isStrArray(r.patterns) ? r.patterns : []} empty="No patterns were reported." />
      </div>
      <div>
        <div className="eyebrow">Hooks quoted from your material</div>
        {isStrArray(r.hooks) && r.hooks.length ? (
          <ul className="quotes">
            {r.hooks.map((h, i) => (
              <li key={i}>
                <q>{h}</q>
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted">No hooks were reported.</p>
        )}
      </div>
      <div>
        <div className="eyebrow">Ideas for you to consider</div>
        <List items={isStrArray(r.ideas) ? r.ideas : []} empty="No ideas were reported." />
      </div>
    </div>
  );
}

export function MarketResult({ result }: { result: unknown }) {
  const r = result as Partial<MarketResearchResult> | null;
  if (!r || typeof r.summary !== 'string') return <p className="small muted">This result has an unexpected format and cannot be shown.</p>;
  const findings = Array.isArray(r.findings) ? r.findings : [];
  const sources = Array.isArray(r.sources) ? r.sources : [];
  return (
    <div className="stack result">
      <div>
        <div className="eyebrow">Summary</div>
        <p style={{ marginTop: 4 }}>{r.summary}</p>
      </div>
      <div>
        <div className="eyebrow">Findings</div>
        {findings.length ? (
          <ul className="findings">
            {findings.map((f, i) => (
              <li key={i}>
                <div style={{ fontWeight: 600 }}>{f.title}</div>
                <p className="small" style={{ margin: '2px 0' }}>{f.detail}</p>
                {f.sourceUrl ? <ExternalLink url={f.sourceUrl} /> : <span className="tiny faint">No source link</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted">No findings were reported.</p>
        )}
      </div>
      {sources.length ? (
        <div>
          <div className="eyebrow">Sources</div>
          <ul className="plain-list">
            {sources.map((s, i) => (
              <li key={i}>
                <span className="truncate">{s.title}</span>
                <ExternalLink url={s.url} />
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="tiny faint">No sources were returned for this run.</p>
      )}
    </div>
  );
}

function RunResult({ run }: { run: ResearchRunDTO }) {
  if (run.status === 'failed') return <Callout tone="err" title="This run failed">{run.error ?? 'No error message was recorded.'}</Callout>;
  return run.kind === 'competitor_analysis' ? <CompetitorResult result={run.result} /> : <MarketResult result={run.result} />;
}

/* =====================================================================================
   Competitors
   ===================================================================================== */
function CompetitorsTab({ competitors, runs, caps, onRunSaved }: { competitors: ReturnType<typeof useAsync<CompetitorDTO[]>>; runs: ResearchRunDTO[]; caps: ResearchCapabilities | undefined; onRunSaved: () => void }) {
  const toast = useToast();
  const [editing, setEditing] = useState<CompetitorDTO | 'new' | null>(null);
  const [analyzing, setAnalyzing] = useState<CompetitorDTO | null>(null);
  const [removing, setRemoving] = useState<CompetitorDTO | null>(null);
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await api.research.deleteCompetitor(removing.id);
      toast.success('Competitor removed', 'Your notes and past analyses were kept.');
      setRemoving(null);
      competitors.reload();
    } catch (e) {
      toast.error(e, 'Could not remove');
    } finally {
      setBusy(false);
    }
  };

  const list = competitors.data;
  return (
    <div className="stack-l">
      <div className="row">
        <p className="muted" style={{ flex: '1 1 300px', margin: 0 }}>
          Add the accounts you follow, then paste in posts or captions you have copied to get an analysis.
        </p>
        <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
          Add competitor
        </Button>
      </div>

      {competitors.error && !list ? (
        <Callout tone="err" title="Could not load competitors">
          {competitors.error.message}
        </Callout>
      ) : !list ? (
        <Skeleton h={90} />
      ) : list.length === 0 ? (
        <EmptyState icon="users" title="No competitors saved yet" action={<Button variant="primary" icon="plus" onClick={() => setEditing('new')}>Add your first competitor</Button>}>
          A competitor is just a saved name, handle and notes. Nothing is fetched from their accounts.
        </EmptyState>
      ) : (
        <ul className="stack">
          {list.map((c) => {
            const mine = runs.filter((r) => r.competitorId === c.id && r.kind === 'competitor_analysis');
            const latest = mine.find((r) => r.status === 'succeeded');
            return (
              <li key={c.id}>
                <Card as="article" className="card-pad stack">
                  <div className="row" style={{ alignItems: 'flex-start' }}>
                    <div style={{ flex: '1 1 260px', minWidth: 0 }}>
                      <h3 className="section-title" style={{ fontSize: 18 }}>
                        {c.name}
                      </h3>
                      <div className="small muted row" style={{ gap: 10 }}>
                        {c.handle ? <span>{c.handle}</span> : null}
                        {c.url ? <ExternalLink url={c.url} /> : null}
                        <span className="faint">added {relativeTime(c.createdAt)}</span>
                      </div>
                    </div>
                    <div className="row" style={{ gap: 6 }}>
                      <Button size="sm" icon="research" onClick={() => setAnalyzing(c)}>
                        Analyze pasted material
                      </Button>
                      <Button size="sm" variant="quiet" icon="edit" onClick={() => setEditing(c)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="quiet" icon="trash" onClick={() => setRemoving(c)} aria-label={`Remove ${c.name}`}>
                        Remove
                      </Button>
                    </div>
                  </div>
                  {c.notes ? <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}>{c.notes}</p> : null}
                  {latest ? (
                    <details className="disclosure">
                      <summary>
                        Latest analysis · {relativeTime(latest.createdAt)}
                        {mine.length > 1 ? ` · ${mine.length} runs in total` : ''}
                      </summary>
                      <div style={{ padding: '0 14px 14px' }}>
                        <CompetitorResult result={latest.result} />
                      </div>
                    </details>
                  ) : null}
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      <CompetitorForm
        item={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          competitors.reload();
        }}
      />
      <AnalyzeDialog competitor={analyzing} caps={caps} onClose={() => setAnalyzing(null)} onRunSaved={onRunSaved} />
      <Modal
        open={!!removing}
        onClose={() => setRemoving(null)}
        locked={busy}
        title={`Remove ${removing?.name ?? 'competitor'}?`}
        footer={
          <>
            <Button variant="quiet" onClick={() => setRemoving(null)} disabled={busy}>
              Keep
            </Button>
            <Button variant="danger" icon="trash" busy={busy} onClick={() => void remove()}>
              Remove competitor
            </Button>
          </>
        }
      >
        <p>This removes the saved entry only. Notes and past analyses are kept, but they will no longer be linked to this competitor.</p>
      </Modal>
    </div>
  );
}

function CompetitorForm({ item, onClose, onSaved }: { item: CompetitorDTO | 'new' | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const existing = item && item !== 'new' ? item : null;
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [url, setUrl] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [seed, setSeed] = useState<unknown>(null);
  // re-seed fields whenever a different item is opened
  if (item !== seed) {
    setSeed(item);
    setName(existing?.name ?? '');
    setHandle(existing?.handle ?? '');
    setUrl(existing?.url ?? '');
    setNotes(existing?.notes ?? '');
  }
  const urlBad = url.trim() !== '' && !safeHttpUrl(url.trim());
  const nameBad = name.trim() === '';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (urlBad || nameBad) return;
    setBusy(true);
    try {
      const body = { name: name.trim(), handle: handle.trim() || null, url: url.trim() || null, notes };
      if (existing) await api.research.updateCompetitor(existing.id, body);
      else await api.research.addCompetitor(body);
      toast.success(existing ? 'Competitor updated' : 'Competitor added');
      onSaved();
    } catch (err) {
      toast.error(err, 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={!!item}
      onClose={onClose}
      locked={busy}
      title={existing ? 'Edit competitor' : 'Add competitor'}
      footer={
        <>
          <Button variant="quiet" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="competitor-form" busy={busy} disabled={nameBad || urlBad}>
            {existing ? 'Save changes' : 'Add competitor'}
          </Button>
        </>
      }
    >
      <form id="competitor-form" className="stack" onSubmit={submit} noValidate>
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="e.g. Studio Morning" />
        <Input label="Handle" optional value={handle} onChange={(e) => setHandle(e.target.value)} maxLength={100} placeholder="@studiomorning" />
        <Input label="Link" optional value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" error={urlBad ? 'Use a web link starting with http:// or https://' : undefined} hint="Saved as a link for you to open. Amir SM never visits it." />
        <Textarea label="Notes" optional rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={3000} />
      </form>
    </Modal>
  );
}

interface Material {
  key: number;
  label: string;
  text: string;
  url: string;
}
let materialKey = 1;
const blank = (): Material => ({ key: materialKey++, label: '', text: '', url: '' });

function AnalyzeDialog({ competitor, caps, onClose, onRunSaved }: { competitor: CompetitorDTO | null; caps: ResearchCapabilities | undefined; onClose: () => void; onRunSaved: () => void }) {
  const toast = useToast();
  const [materials, setMaterials] = useState<Material[]>([blank()]);
  const [focus, setFocus] = useState('');
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<ResearchRunDTO | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [seed, setSeed] = useState<string | null>(null);
  if ((competitor?.id ?? null) !== seed) {
    setSeed(competitor?.id ?? null);
    setMaterials([blank()]);
    setFocus('');
    setRun(null);
    setErr(null);
  }

  const cap = caps?.competitorAnalysis;
  const blocked = cap ? !cap.available : false;
  const update = (key: number, p: Partial<Material>) => setMaterials((m) => m.map((x) => (x.key === key ? { ...x, ...p } : x)));
  const filled = materials.filter((m) => m.label.trim() || m.text.trim() || m.url.trim());
  const problems = filled.map((m) => (!m.label.trim() ? 'needs a label' : !m.text.trim() ? 'needs the pasted text' : m.url.trim() && !safeHttpUrl(m.url.trim()) ? 'link must be http(s)' : m.text.length > 8000 ? 'text is over 8000 characters' : null));
  const valid = filled.length > 0 && problems.every((p) => !p);

  const go = async () => {
    if (!competitor || !valid) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.research.analyze(competitor.id, {
        materials: filled.map((m) => ({ label: m.label.trim(), text: m.text.trim(), ...(m.url.trim() ? { url: m.url.trim() } : {}) })),
        focus: focus.trim() || undefined,
      });
      setRun(r);
      onRunSaved();
    } catch (e) {
      setErr((e as Error).message);
      toast.error(e, 'Analysis failed');
      onRunSaved();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={!!competitor}
      onClose={onClose}
      locked={busy}
      title={`Analyze material: ${competitor?.name ?? ''}`}
      footer={
        <>
          <Button variant="quiet" onClick={onClose} disabled={busy}>
            {run ? 'Close' : 'Cancel'}
          </Button>
          {!run ? (
            <Button variant="primary" busy={busy} disabled={blocked || !valid} onClick={() => void go()}>
              Run analysis
            </Button>
          ) : (
            <Button onClick={() => setRun(null)}>Edit and run again</Button>
          )}
        </>
      }
    >
      <div className="stack analyze">
        <Callout tone="info">
          Paste text you copied yourself (captions, post text, notes). Amir SM reads <strong>only what is pasted here</strong>; it does not fetch the account or any link you add.
        </Callout>
        {blocked ? (
          <Callout tone="warn" title="Analysis is unavailable">
            {cap?.reason}
          </Callout>
        ) : null}
        {run ? (
          <>
            <RunResult run={run} />
            <p className="tiny faint">Saved to History. Counts toward your daily AI usage.</p>
          </>
        ) : (
          <>
            <div className="stack">
              {materials.map((m, i) => (
                <fieldset key={m.key} className="material">
                  <legend>Snippet {i + 1}</legend>
                  <div className="stack-s">
                    <Input label="Label" value={m.label} onChange={(e) => update(m.key, { label: e.target.value })} maxLength={120} placeholder="e.g. Caption, 12 Oct reel" />
                    <Textarea label="Pasted text" rows={4} value={m.text} onChange={(e) => update(m.key, { text: e.target.value })} maxLength={8000} hint={`${m.text.length}/8000`} />
                    <Input label="Source link" optional value={m.url} onChange={(e) => update(m.key, { url: e.target.value })} placeholder="https://…" error={m.url.trim() && !safeHttpUrl(m.url.trim()) ? 'Use a web link starting with http:// or https://' : undefined} />
                    {problems[filled.indexOf(m)] ? <div className="tiny" style={{ color: 'var(--err)' }}>This snippet {problems[filled.indexOf(m)]}.</div> : null}
                    {materials.length > 1 ? (
                      <div>
                        <Button size="sm" variant="quiet" icon="trash" onClick={() => setMaterials((x) => x.filter((y) => y.key !== m.key))}>
                          Remove snippet {i + 1}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </fieldset>
              ))}
              <div className="row">
                <Button size="sm" icon="plus" disabled={materials.length >= 12} onClick={() => setMaterials((m) => [...m, blank()])}>
                  Add another snippet
                </Button>
                <span className="small muted">{materials.length} of 12</span>
              </div>
            </div>
            <Textarea label="What should the analysis focus on?" optional rows={2} value={focus} onChange={(e) => setFocus(e.target.value)} maxLength={300} placeholder="e.g. how they open their videos" />
            {err ? <Callout tone="err" title="The analysis failed">{err}</Callout> : null}
          </>
        )}
      </div>
    </Modal>
  );
}

/* =====================================================================================
   Notes
   ===================================================================================== */
const NOTE_KINDS: { id: ResearchNoteDTO['kind']; label: string }[] = [
  { id: 'observation', label: 'Observation' },
  { id: 'idea', label: 'Idea' },
  { id: 'inspiration', label: 'Inspiration' },
];

function NotesTab({ competitors }: { competitors: CompetitorDTO[] }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const dq = useDebounced(q.trim(), 250);
  const notes = useAsync((s) => api.research.notes({ q: dq || undefined, kind: kind || undefined }, s), [dq, kind]);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ResearchNoteDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const names = useMemo(() => new Map(competitors.map((c) => [c.id, c.name])), [competitors]);

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await api.research.deleteNote(removing.id);
      toast.success('Note deleted');
      setRemoving(null);
      notes.reload();
    } catch (e) {
      toast.error(e, 'Could not delete');
    } finally {
      setBusy(false);
    }
  };

  const list = notes.data;
  const filtering = !!dq || !!kind;
  return (
    <div className="stack-l">
      <div className="filters" style={{ marginBottom: 0 }}>
        <div className="search-wrap" style={{ flex: '1 1 240px' }}>
          <Icon name="search" />
          <input className="input input-search" type="search" placeholder="Search titles, text and tags" aria-label="Search notes" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div style={{ flex: '0 1 190px' }}>
          <select className="select" aria-label="Filter by kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">All kinds</option>
            {NOTE_KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
        <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>
          Add note
        </Button>
      </div>

      {notes.error && !list ? (
        <Callout tone="err" title="Could not load notes">
          {notes.error.message}
        </Callout>
      ) : !list ? (
        <Skeleton h={90} />
      ) : list.length === 0 ? (
        filtering ? (
          <EmptyState icon="search" title="No notes match" action={<Button onClick={() => { setQ(''); setKind(''); }}>Clear filters</Button>}>
            Try another word or kind.
          </EmptyState>
        ) : (
          <EmptyState icon="note" title="No notes yet" action={<Button variant="primary" icon="plus" onClick={() => setAdding(true)}>Add a note</Button>}>
            Jot down something you noticed, an idea for a video, or something that inspired you. You can link it to a source and a competitor.
          </EmptyState>
        )
      ) : (
        <ul className="stack">
          {list.map((n) => (
            <li key={n.id}>
              <Card as="article" className="card-pad stack-s">
                <div className="row" style={{ alignItems: 'flex-start' }}>
                  <Badge tone={n.kind === 'idea' ? 'accent' : n.kind === 'inspiration' ? 'info' : 'neutral'}>{NOTE_KINDS.find((k) => k.id === n.kind)?.label ?? n.kind}</Badge>
                  <h3 style={{ fontSize: 16, flex: '1 1 200px', minWidth: 0, overflowWrap: 'anywhere' }}>{n.title}</h3>
                  <span className="tiny faint nowrap">{relativeTime(n.createdAt)}</span>
                  <Button size="sm" variant="quiet" icon="trash" onClick={() => setRemoving(n)} aria-label={`Delete note ${n.title}`}>
                    Delete
                  </Button>
                </div>
                {n.body ? <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}>{n.body}</p> : null}
                <div className="row small muted" style={{ gap: 10 }}>
                  {n.sourceUrl ? <ExternalLink url={n.sourceUrl}>{n.sourceLabel || undefined}</ExternalLink> : n.sourceLabel ? <span>Source: {n.sourceLabel}</span> : null}
                  {n.competitorId ? <span>About {names.get(n.competitorId) ?? 'a removed competitor'}</span> : null}
                </div>
                {n.tags.length ? (
                  <div className="chip-list" aria-label="Tags">
                    {n.tags.map((t) => (
                      <span key={t} className="chip">
                        {t}
                      </span>
                    ))}
                  </div>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}

      <NoteForm
        open={adding}
        competitors={competitors}
        onClose={() => setAdding(false)}
        onSaved={() => {
          setAdding(false);
          notes.reload();
        }}
      />
      <Modal
        open={!!removing}
        onClose={() => setRemoving(null)}
        locked={busy}
        title="Delete this note?"
        footer={
          <>
            <Button variant="quiet" onClick={() => setRemoving(null)} disabled={busy}>
              Keep
            </Button>
            <Button variant="danger" icon="trash" busy={busy} onClick={() => void remove()}>
              Delete note
            </Button>
          </>
        }
      >
        <p>“{removing?.title}” will be permanently deleted. This cannot be undone.</p>
      </Modal>
    </div>
  );
}

function NoteForm({ open, competitors, onClose, onSaved }: { open: boolean; competitors: CompetitorDTO[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [kind, setKind] = useState<ResearchNoteDTO['kind']>('observation');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [tags, setTags] = useState('');
  const [competitorId, setCompetitorId] = useState('');
  const [busy, setBusy] = useState(false);
  const urlBad = url.trim() !== '' && !safeHttpUrl(url.trim());
  const tagList = tags.split(/[,\n]/).map((t) => t.trim()).filter(Boolean);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim() || urlBad || tagList.length > 12) return;
    setBusy(true);
    try {
      await api.research.addNote({ kind, title: title.trim(), body, sourceUrl: url.trim() || null, sourceLabel: label.trim() || null, competitorId: competitorId || null, tags: tagList });
      toast.success('Note saved');
      setTitle('');
      setBody('');
      setLabel('');
      setUrl('');
      setTags('');
      setCompetitorId('');
      onSaved();
    } catch (err) {
      toast.error(err, 'Could not save the note');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      locked={busy}
      title="Add a note"
      footer={
        <>
          <Button variant="quiet" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="note-form" busy={busy} disabled={!title.trim() || urlBad || tagList.length > 12}>
            Save note
          </Button>
        </>
      }
    >
      <form id="note-form" className="stack" onSubmit={submit} noValidate>
        <Select label="Kind" value={kind} onChange={(e) => setKind(e.target.value as ResearchNoteDTO['kind'])}>
          {NOTE_KINDS.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
            </option>
          ))}
        </Select>
        <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} />
        <Textarea label="Details" optional rows={4} value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} />
        <Input label="Source name" optional value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} placeholder="e.g. Their reel on 12 Oct" />
        <Input label="Source link" optional value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" error={urlBad ? 'Use a web link starting with http:// or https://' : undefined} />
        <Input label="Tags" optional value={tags} onChange={(e) => setTags(e.target.value)} hint="Separate with commas. Up to 12." error={tagList.length > 12 ? 'At most 12 tags.' : undefined} />
        {competitors.length ? (
          <Select label="About a competitor" optional value={competitorId} onChange={(e) => setCompetitorId(e.target.value)}>
            <option value="">None</option>
            {competitors.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        ) : null}
      </form>
    </Modal>
  );
}

/* =====================================================================================
   Market research
   ===================================================================================== */
function MarketTab({ caps, capsError, onRunSaved }: { caps: ResearchCapabilities | undefined; capsError?: string; onRunSaved: () => void }) {
  const toast = useToast();
  const [topic, setTopic] = useState('');
  const [niche, setNiche] = useState('');
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<ResearchRunDTO | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const cap = caps?.marketResearch;
  const blocked = cap ? !cap.available : false;
  const tooShort = topic.trim().length < 3;

  const go = async (e: FormEvent) => {
    e.preventDefault();
    if (tooShort || blocked) return;
    setBusy(true);
    setErr(null);
    setRun(null);
    try {
      setRun(await api.research.market({ topic: topic.trim(), niche: niche.trim() || undefined }));
      onRunSaved();
    } catch (e2) {
      setErr((e2 as Error).message);
      toast.error(e2, 'Market research failed');
      onRunSaved();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-l" style={{ maxWidth: 820 }}>
      {cap && !cap.available ? (
        <Callout tone="warn" title="Market research is unavailable">
          {cap.reason}
        </Callout>
      ) : cap ? (
        <Callout tone="info">Market research uses Anthropic web search, which is billed per search. Every finding should come with a source link. Check the sources yourself before relying on a claim.</Callout>
      ) : capsError ? (
        <Callout tone="err" title="Could not check availability">
          {capsError}
        </Callout>
      ) : null}
      <Card as="section">
        <CardHeader icon="globe" title="Research a topic" />
        <form className="card-body stack" onSubmit={go} noValidate>
          <Input label="Topic" value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={200} disabled={blocked} placeholder="e.g. slow-living content trends" hint="At least 3 characters." />
          <Input label="Niche" optional value={niche} onChange={(e) => setNiche(e.target.value)} maxLength={120} disabled={blocked} placeholder="e.g. lifestyle creators" />
          <div className="row">
            <Button type="submit" variant="primary" icon="search" busy={busy} disabled={blocked || tooShort || !cap} title={blocked ? cap?.reason : undefined}>
              Run research
            </Button>
            {blocked ? <span className="small muted">Disabled: see the reason above.</span> : null}
          </div>
        </form>
      </Card>
      {err ? <Callout tone="err" title="The research run failed">{err}</Callout> : null}
      {run ? (
        <Card as="section" aria-label="Research result">
          <CardHeader title={`Findings: ${run.topic}`} subtitle={`Source: ${run.source}`} />
          <div className="card-body">
            <RunResult run={run} />
          </div>
        </Card>
      ) : null}
    </div>
  );
}

/* =====================================================================================
   History
   ===================================================================================== */
function HistoryTab({ runs }: { runs: ReturnType<typeof useAsync<ResearchRunDTO[]>> }) {
  const list = runs.data;
  if (runs.error && !list)
    return (
      <Callout tone="err" title="Could not load history">
        {runs.error.message}
      </Callout>
    );
  if (!list) return <Skeleton h={90} />;
  if (list.length === 0)
    return (
      <EmptyState icon="history" title="No research runs yet">
        Competitor analyses and market research runs, including failed ones, are listed here with their results.
      </EmptyState>
    );
  return (
    <ul className="stack">
      {list.map((r) => (
        <li key={r.id}>
          <details className="disclosure run">
            <summary>
              <span className="run-title">
                <Badge tone={r.kind === 'competitor_analysis' ? 'info' : 'accent'}>{r.kind === 'competitor_analysis' ? 'Competitor analysis' : 'Market research'}</Badge>
                <span className="truncate" style={{ fontWeight: 600 }}>
                  {r.topic}
                </span>
              </span>
              <Badge tone={r.status === 'succeeded' ? 'ok' : 'err'} dot>
                {r.status === 'succeeded' ? 'Succeeded' : 'Failed'}
              </Badge>
              <span className="tiny faint nowrap">{relativeTime(r.createdAt)}</span>
            </summary>
            <div style={{ padding: '0 14px 14px' }} className="stack">
              <div className="tiny muted">Source: {r.source}</div>
              <RunResult run={r} />
            </div>
          </details>
        </li>
      ))}
    </ul>
  );
}
