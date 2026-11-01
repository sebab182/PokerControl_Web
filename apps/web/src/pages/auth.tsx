import type { ApiAuthResponse, ApiGroup, ApiGroupRef } from '@pokercontrol/contracts';
import { GoogleLogin } from '@react-oauth/google';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, setToken } from '../api';
import { Btn, Emoji, TextField, useAction, useFeedback } from '../components/ui';
import { useSession } from '../context';

export function LoginPage() {
  const { signIn } = useSession();
  const { notify } = useFeedback();
  const { busy, run } = useAction();

  return (
    <main className="main" style={{ maxWidth: 420, textAlign: 'center', paddingTop: '18vh' }}>
      <h1><Emoji>♠</Emoji> PokerControl</h1>
      <p className="muted" style={{ margin: '12px 0 28px' }}>
        Compras, resultados y deudas de tus partidas entre amigos.
      </p>
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <GoogleLogin
          text="continue_with"
          locale="es"
          onError={() => notify('No se pudo iniciar sesión con Google.')}
          onSuccess={r => {
            const idToken = r.credential;
            if (!idToken) return notify('Google no devolvió credenciales.');
            void run(async () => {
              const { token } = await api<ApiAuthResponse>('/auth/google', { method: 'POST', body: { idToken } });
              setToken(token);
              signIn(token);
            });
          }}
        />
      </div>
      {busy && <p className="muted small" role="status" style={{ marginTop: 16 }}>Ingresando…</p>}
    </main>
  );
}

/** Crear o unirse a un grupo. Se usa en el primer ingreso y desde Configuración. */
export function GroupChooser({ onDone }: { onDone: () => void }) {
  const { refreshMe, selectGroup } = useSession();
  const create = useAction();
  const join = useAction();
  const { notify } = useFeedback();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [created, setCreated] = useState<ApiGroup | null>(null);

  if (created) {
    return (
      <div className="card center">
        <h2><Emoji>🎉</Emoji> Grupo creado</h2>
        <p className="muted" style={{ margin: '8px 0 16px' }}>Compartí este código para que tus amigos se unan:</p>
        <p className="big num" data-testid="invite-code">{created.inviteCode}</p>
        <div className="modal-actions" style={{ justifyContent: 'center' }}>
          <Btn variant="ghost" onClick={() => {
            void navigator.clipboard.writeText(created.inviteCode).then(() => notify('Código copiado.'));
          }}>Copiar</Btn>
          {/* Refrescar antes desmontaría esta vista: el onboarding redirige al tener grupo. */}
          <Btn busy={create.busy} onClick={() => {
            void create.run(async () => {
              await refreshMe();
              selectGroup(created.id);
              onDone();
            });
          }}>Continuar</Btn>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <form className="card" onSubmit={e => {
        e.preventDefault();
        if (!name.trim()) return notify('Ingresá un nombre para el grupo.');
        void create.run(async () => {
          const group = await api<ApiGroup>('/groups', {
            method: 'POST',
            body: { name: name.trim(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
          });
          setCreated(group);
        });
      }}>
        <h2 style={{ marginBottom: 12 }}>Crear un grupo nuevo</h2>
        <TextField label="Nombre del grupo" value={name} onChange={setName} placeholder="Ej: Los viernes" maxLength={120} />
        <Btn type="submit" block busy={create.busy}>Crear grupo</Btn>
      </form>
      <form className="card" onSubmit={e => {
        e.preventDefault();
        if (!code.trim()) return notify('Ingresá el código de invitación.');
        void join.run(async () => {
          const group = await api<ApiGroupRef>('/groups/join', { method: 'POST', body: { inviteCode: code.trim() } });
          await refreshMe();
          selectGroup(group.id);
          onDone();
        });
      }}>
        <h2 style={{ marginBottom: 12 }}>Unirme a un grupo</h2>
        <TextField label="Código de invitación" value={code} onChange={setCode} placeholder="Ej: ABCD2345" maxLength={16} />
        <Btn type="submit" variant="ghost" block busy={join.busy}>Unirme</Btn>
      </form>
    </div>
  );
}

export function OnboardingPage() {
  const navigate = useNavigate();
  const { signOut, me } = useSession();
  return (
    <main className="main" style={{ maxWidth: 480 }}>
      <h1 style={{ marginBottom: 4 }}>Hola, {me?.user.name}</h1>
      <p className="muted" style={{ marginBottom: 20 }}>Para empezar, creá un grupo o unite a uno.</p>
      <GroupChooser onDone={() => navigate('/seasons', { replace: true })} />
      <Btn variant="text" onClick={signOut}>Cerrar sesión</Btn>
    </main>
  );
}
