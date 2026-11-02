import type { ApiAdminOverview, ApiGroup, ApiImportResult, ApiPlayer } from '@pokercontrol/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api } from '../api';
import { Avatar, Btn, Emoji, Loading, Modal, QueryError, TextField, useAction, useFeedback } from '../components/ui';
import { useGroup, useSession, useTheme, type Theme } from '../context';
import { shareInvite } from '../share';
import { GroupChooser, NickChooser } from './auth';

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

const ROLE_LABEL = { master: 'Master', admin: 'Admin', reader: 'Solo lectura' };

function AdminsCard() {
  const { confirm } = useFeedback();
  const { busy, run } = useAction();
  const qc = useQueryClient();
  const queryKey = ['admin-users'];
  const query = useQuery({ queryKey, queryFn: () => api<ApiAdminOverview>('/admin/users') });
  const [email, setEmail] = useState('');

  const grant = (target: string) => run(async () => {
    qc.setQueryData(queryKey, await api<ApiAdminOverview>('/admin/admins', { method: 'POST', body: { email: target } }));
    setEmail('');
  });
  const revoke = async (target: string) => {
    const ok = await confirm({
      title: 'Quitar administrador', danger: true, confirmLabel: 'Quitar',
      message: `${target} va a pasar a solo lectura.`,
    });
    if (!ok) return;
    void run(async () => {
      qc.setQueryData(queryKey, await api<ApiAdminOverview>(`/admin/admins/${encodeURIComponent(target)}`, { method: 'DELETE' }));
    });
  };

  return (
    <div className="card" data-testid="admins-card">
      <h2>Administradores</h2>
      <p className="small muted" style={{ margin: '4px 0 12px' }}>
        Pueden crear grupos, invitar y modificar datos. Si todavía no ingresó, queda nombrado para su primer login.
      </p>
      <form onSubmit={e => {
        e.preventDefault();
        if (email.trim()) void grant(email.trim());
      }}>
        <TextField label="Email de Google" value={email} onChange={setEmail} maxLength={320} placeholder="nombre@gmail.com" />
        <Btn type="submit" variant="ghost" busy={busy} disabled={!email.trim()}>Nombrar admin</Btn>
      </form>
      {query.isLoading && <Loading />}
      {query.error && <QueryError error={query.error} onRetry={() => { void query.refetch(); }} />}
      {query.data?.pending.map(p => (
        <div className="list-row" key={p.email}>
          <div className="grow ellipsis">{p.email}</div>
          <span className="badge badge-amber">Pendiente</span>
          <Btn variant="text" aria-label={`Quitar a ${p.email}`} onClick={() => { void revoke(p.email); }}>Quitar</Btn>
        </div>
      ))}
      {query.data?.users.map(u => (
        <div className="list-row" key={u.id}>
          <div className="grow">
            <div className="ellipsis">{u.name}</div>
            <div className="xs muted ellipsis">{u.email}</div>
          </div>
          <span className="badge badge-muted">{ROLE_LABEL[u.role]}</span>
          {u.role === 'reader' && <Btn variant="text" busy={busy} aria-label={`Hacer admin a ${u.name}`} onClick={() => { void grant(u.email); }}>Hacer admin</Btn>}
          {u.role === 'admin' && <Btn variant="text" aria-label={`Quitar a ${u.name}`} onClick={() => { void revoke(u.email); }}>Quitar</Btn>}
        </div>
      ))}
    </div>
  );
}

export function SettingsPage() {
  const { path, key, invalidate, canEdit, group: activeGroup } = useGroup();
  const { signOut, me, refreshMe, selectGroup } = useSession();
  const qc = useQueryClient();
  const { confirm, notify } = useFeedback();
  const { busy, run } = useAction();
  const [theme, setTheme] = useTheme();
  const query = useQuery({ queryKey: key('group-details'), queryFn: () => api<ApiGroup>(path('')) });
  const players = useQuery({ queryKey: key('players', 'all'), queryFn: () => api<ApiPlayer[]>(path('/players?includeArchived=true')) });
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('');
  const [chooser, setChooser] = useState(false);

  if (query.isLoading) return <Loading />;
  if (query.error || !query.data) return <QueryError error={query.error} onRetry={() => { void query.refetch(); }} />;
  const group = query.data;
  const groups = me?.groups ?? [];
  const inviteCode = group.inviteCode;
  const allPlayers = players.data ?? [];
  const playerName = (id: string | null) => allPlayers.find(p => p.id === id)?.name;

  /** Corrige a qué jugador está asociado un miembro. */
  const relink = (userId: string, current: string | null, next: string) => {
    void run(async () => {
      if (next) await api(path(`/players/${next}/user`), { method: 'POST', body: { userId } });
      else if (current) await api(path(`/players/${current}/user`), { method: 'POST', body: { userId: null } });
      await invalidate();
      await refreshMe();
    });
  };

  const rotate = async () => {
    const ok = await confirm({
      title: 'Regenerar código', confirmLabel: 'Regenerar',
      message: 'El código actual y los links ya compartidos dejan de funcionar. Los miembros actuales siguen en el grupo.',
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
          {canEdit && <Btn variant="ghost" onClick={() => { setName(group.name); setTimezone(group.timezone); setEditing(true); }}>Editar</Btn>}
        </div>
        {inviteCode && (
          <>
            <h3 style={{ marginTop: 16 }}>Código de invitación</h3>
            <p className="big num" style={{ fontSize: 28 }} data-testid="settings-invite">{inviteCode}</p>
            <div className="row-wrap" style={{ marginTop: 8 }}>
              <Btn variant="ghost" onClick={() => {
                void navigator.clipboard.writeText(inviteCode).then(() => notify('Código copiado.'));
              }}>Copiar</Btn>
              <Btn variant="ghost" onClick={() => { void shareInvite(group.name, inviteCode, notify); }}>
                <Emoji>📤</Emoji> Compartir por WhatsApp
              </Btn>
              <Btn variant="ghost" busy={busy} onClick={() => { void rotate(); }}>Regenerar</Btn>
            </div>
          </>
        )}
      </div>

      <div className="card">
        <h2>Miembros ({group.members.length})</h2>
        {group.members.map(m => (
          <div className="list-row" key={m.id}>
            <Avatar name={m.name} />
            <div className="grow">
              <div className="ellipsis">{m.name}</div>
              {m.email && <div className="xs muted ellipsis">{m.email}</div>}
              {!canEdit && m.playerId && <div className="xs muted ellipsis">Juega como {playerName(m.playerId)}</div>}
            </div>
            {canEdit && (
              <select value={m.playerId ?? ''} disabled={busy} aria-label={`Jugador de ${m.name}`}
                style={{ maxWidth: '45%' }} onChange={e => relink(m.id, m.playerId, e.target.value)}>
                <option value="">Sin jugador</option>
                {allPlayers.filter(p => p.id === m.playerId || (!p.linked && !p.archivedAt)).map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            )}
          </div>
        ))}
        {group.isMember && (
          <Btn variant="danger" style={{ marginTop: 12 }} busy={busy} disabled={group.members.length <= 1}
            onClick={() => { void leave(); }}>Abandonar grupo</Btn>
        )}
        {group.isMember && group.members.length <= 1 && <p className="xs muted" style={{ marginTop: 6 }}>Sos el único miembro: no podés abandonar el grupo.</p>}
      </div>

      {canEdit && !activeGroup.playerId && (
        <>
          <h2 className="section-title">Mi jugador en este grupo</h2>
          <NickChooser />
        </>
      )}

      {me?.user.role === 'master' && <AdminsCard />}

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
        <Btn variant="ghost" onClick={() => setChooser(true)}>{canEdit ? 'Crear o unirme a otro grupo' : 'Unirme a otro grupo'}</Btn>
      </div>

      <div className="card">
        <h2 style={{ marginBottom: 12 }}>Tema</h2>
        <div className="segmented" style={{ marginBottom: 0 }}>
          {THEMES.map(t => (
            <Btn key={t.value} variant="ghost" aria-pressed={theme === t.value} onClick={() => setTheme(t.value)}>{t.label}</Btn>
          ))}
        </div>
      </div>

      {canEdit && <BackupCard />}

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
