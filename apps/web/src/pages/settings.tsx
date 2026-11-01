import type { ApiGroup, ApiImportResult } from '@pokercontrol/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api } from '../api';
import { Avatar, Btn, Emoji, Loading, Modal, QueryError, TextField, useAction, useFeedback } from '../components/ui';
import { useGroup, useSession, useTheme, type Theme } from '../context';
import { GroupChooser } from './auth';

const THEMES: { value: Theme; label: string }[] = [
  { value: 'system', label: 'Sistema' }, { value: 'light', label: 'Claro' }, { value: 'dark', label: 'Oscuro' },
];

function BackupCard() {
  const { path, invalidate, group } = useGroup();
  const { notify } = useFeedback();
  const { busy, run } = useAction();
  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ file: unknown; result: ApiImportResult; name: string } | null>(null);

  const exportBackup = () => run(async () => {
    const data = await api<unknown>(path('/backup/export'));
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `PokerControl_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  const chooseFile = (file: File | undefined) => {
    if (!file) return;
    void run(async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await file.text());
      } catch {
        throw new Error('No se pudo leer el archivo. ¿Es un JSON válido?');
      }
      const result = await api<ApiImportResult>(path('/backup/import?dryRun=true'), { method: 'POST', body: parsed });
      setPending({ file: parsed, result, name: file.name });
    }).finally(() => { if (input.current) input.current.value = ''; });
  };

  const counts = pending?.result.counts;

  return (
    <div className="card">
      <h2>Backup</h2>
      <p className="small muted" style={{ margin: '4px 0 12px' }}>
        Exportá los datos del grupo, o importá un backup de la app. Importar reemplaza todos los datos de este grupo.
      </p>
      <div className="row-wrap">
        <Btn variant="ghost" busy={busy} onClick={() => { void exportBackup(); }}>Exportar JSON</Btn>
        <Btn variant="ghost" busy={busy} onClick={() => input.current?.click()}>Importar JSON</Btn>
        <input ref={input} type="file" accept="application/json,.json" hidden aria-label="Archivo de backup"
          data-testid="backup-file" onChange={e => chooseFile(e.target.files?.[0])} />
      </div>

      <Modal open={!!pending} onClose={() => setPending(null)} title="Importar backup"
        description={`Se van a reemplazar TODOS los datos de "${group.name}" con ${pending?.name ?? ''}. No se puede deshacer.`}>
        {counts && (
          <ul className="small" style={{ paddingLeft: 18, margin: '0 0 8px' }}>
            <li>{counts.players} jugadores ({counts.archivedPlayers} reconstruidos como archivados)</li>
            <li>{counts.seasons} temporadas · {counts.sessions} partidas</li>
            <li>{counts.debts} deudas · {counts.adjustments} ajustes</li>
          </ul>
        )}
        {pending && pending.result.warnings.length > 0 && (
          <div className="notice notice-warn">
            <strong>Avisos:</strong>
            <ul style={{ paddingLeft: 18, margin: '4px 0 0', maxHeight: 160, overflowY: 'auto' }}>
              {pending.result.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        )}
        <div className="modal-actions">
          <Btn variant="ghost" onClick={() => setPending(null)}>Cancelar</Btn>
          <Btn variant="danger" busy={busy} onClick={() => {
            void run(async () => {
              await api(path('/backup/import'), { method: 'POST', body: pending?.file });
              await invalidate();
              setPending(null);
              notify('Backup importado.');
            });
          }}>Reemplazar todo</Btn>
        </div>
      </Modal>
    </div>
  );
}

export function SettingsPage() {
  const { path, key, invalidate } = useGroup();
  const { signOut, me, refreshMe, selectGroup } = useSession();
  const qc = useQueryClient();
  const { confirm, notify } = useFeedback();
  const { busy, run } = useAction();
  const [theme, setTheme] = useTheme();
  const query = useQuery({ queryKey: key('group-details'), queryFn: () => api<ApiGroup>(path('')) });
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('');
  const [chooser, setChooser] = useState(false);

  if (query.isLoading) return <Loading />;
  if (query.error || !query.data) return <QueryError error={query.error} onRetry={() => { void query.refetch(); }} />;
  const group = query.data;
  const groups = me?.groups ?? [];

  const rotate = async () => {
    const ok = await confirm({
      title: 'Regenerar código', confirmLabel: 'Regenerar',
      message: 'El código actual deja de funcionar. Los miembros actuales siguen en el grupo.',
    });
    if (!ok) return;
    void run(async () => {
      await api(path('/invite/rotate'), { method: 'POST' });
      await invalidate();
    });
  };

  const leave = async () => {
    const ok = await confirm({
      title: 'Abandonar grupo', danger: true, confirmLabel: 'Abandonar',
      message: `¿Abandonar "${group.name}"? Para volver vas a necesitar un código de invitación.`,
    });
    if (!ok) return;
    void run(async () => {
      await api(path('/members/me'), { method: 'DELETE' });
      const next = groups.find(g => g.id !== group.id);
      if (next) selectGroup(next.id);
      await refreshMe();
      qc.removeQueries({ queryKey: [group.id] });
    });
  };

  return (
    <>
      <h1 style={{ marginBottom: 12 }}>Configuración</h1>

      <div className="card">
        <div className="row-between">
          <div className="grow">
            <h2 className="ellipsis">{group.name}</h2>
            <p className="small muted">Zona horaria: {group.timezone}</p>
          </div>
          <Btn variant="ghost" onClick={() => { setName(group.name); setTimezone(group.timezone); setEditing(true); }}>Editar</Btn>
        </div>
        <h3 style={{ marginTop: 16 }}>Código de invitación</h3>
        <p className="big num" style={{ fontSize: 28 }} data-testid="settings-invite">{group.inviteCode}</p>
        <div className="row-wrap" style={{ marginTop: 8 }}>
          <Btn variant="ghost" onClick={() => {
            void navigator.clipboard.writeText(group.inviteCode).then(() => notify('Código copiado.'));
          }}>Copiar</Btn>
          <Btn variant="ghost" busy={busy} onClick={() => { void rotate(); }}>Regenerar</Btn>
        </div>
      </div>

      <div className="card">
        <h2>Miembros ({group.members.length})</h2>
        {group.members.map(m => (
          <div className="list-row" key={m.id}>
            <Avatar name={m.name} />
            <div className="grow">
              <div className="ellipsis">{m.name}</div>
              <div className="xs muted ellipsis">{m.email}</div>
            </div>
          </div>
        ))}
        <Btn variant="danger" style={{ marginTop: 12 }} busy={busy} disabled={group.members.length <= 1}
          onClick={() => { void leave(); }}>Abandonar grupo</Btn>
        {group.members.length <= 1 && <p className="xs muted" style={{ marginTop: 6 }}>Sos el único miembro: no podés abandonar el grupo.</p>}
      </div>

      <div className="card">
        <h2 style={{ marginBottom: 12 }}>Mis grupos</h2>
        {groups.length > 1 && (
          <label className="field">
            Grupo activo
            <select value={group.id} onChange={e => selectGroup(e.target.value)}>
              {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </label>
        )}
        <Btn variant="ghost" onClick={() => setChooser(true)}>Crear o unirme a otro grupo</Btn>
      </div>

      <div className="card">
        <h2 style={{ marginBottom: 12 }}>Tema</h2>
        <div className="segmented" style={{ marginBottom: 0 }}>
          {THEMES.map(t => (
            <Btn key={t.value} variant="ghost" aria-pressed={theme === t.value} onClick={() => setTheme(t.value)}>{t.label}</Btn>
          ))}
        </div>
      </div>

      <BackupCard />

      <div className="card">
        <h2><Emoji>♠</Emoji> PokerControl</h2>
        <p className="small muted" style={{ margin: '4px 0' }}>
          Agrupá tus partidas en temporadas: cada temporada arranca podio y estadísticas en cero.
          Las deudas pendientes siempre quedan visibles, sin importar la temporada.
        </p>
        <p className="small muted" style={{ marginBottom: 12 }}>Sesión iniciada como {me?.user.email}.</p>
        <Btn variant="ghost" onClick={signOut}>Cerrar sesión</Btn>
      </div>

      <Modal open={editing} onClose={() => setEditing(false)} title="Editar grupo">
        <form onSubmit={e => {
          e.preventDefault();
          void run(async () => {
            await api(path(''), { method: 'PATCH', body: { name, timezone } });
            await invalidate();
            await refreshMe();
            setEditing(false);
          });
        }}>
          <TextField label="Nombre" value={name} onChange={setName} maxLength={120} autoFocus />
          <TextField label="Zona horaria" value={timezone} onChange={setTimezone} placeholder="America/Argentina/Buenos_Aires" />
          <div className="modal-actions">
            <Btn variant="ghost" onClick={() => setEditing(false)}>Cancelar</Btn>
            <Btn type="submit" busy={busy} disabled={!name.trim()}>Guardar</Btn>
          </div>
        </form>
      </Modal>

      <Modal open={chooser} onClose={() => setChooser(false)} title="Otro grupo">
        <GroupChooser onDone={() => setChooser(false)} />
      </Modal>
    </>
  );
}
