/**
 * A super admin edits the OTHER admin accounts (/admins): role, status, name, e-mail, password.
 *
 * Real Express app and the dev database (like every other suite), real sign-in through POST /auth/login. Everything created is named
 * "adm-<run>-…@example.com" and removed at the end (with the audit_logs rows about those accounts). No network.
 */
import bcrypt from 'bcryptjs';
import request from 'supertest';
import app from '../../app';
import pool from '../../config/db';
import Admin from '../../models/Admin';

jest.setTimeout(60_000);

const RUN = Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
const email = (tag: string): string => `adm-${RUN}-${tag}@example.com`;
const PASSWORD = 'adm-test-password';

type Role = 'super_admin' | 'content_editor' | 'moderator';
type Agent = ReturnType<typeof request.agent>;

interface Fixture {
  id: string;
  email: string;
  agent: Agent;
}

async function createAdmin(tag: string, role: Role, status = 'active'): Promise<{ id: string; email: string }> {
  const { rows } = await pool.query(
    `INSERT INTO admin_accounts (email, password_hash, full_name, role, status) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [email(tag), bcrypt.hashSync(PASSWORD, 4), `Adm ${tag}`, role, status]
  );
  return { id: rows[0].id, email: email(tag) };
}

async function signIn(address: string, password = PASSWORD): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent.post('/auth/login').type('form').send({ email: address, password });
  if (res.status !== 302 || res.headers.location !== '/dashboard') throw new Error(`sign-in of ${address} failed: ${res.status} ${res.headers.location}`);
  return agent;
}

async function fixture(tag: string, role: Role): Promise<Fixture> {
  const a = await createAdmin(tag, role);
  return { ...a, agent: await signIn(a.email) };
}

const row = async (id: string) =>
  (await pool.query('SELECT email, full_name, role, status, password_hash FROM admin_accounts WHERE id = $1', [id])).rows[0];

/** The form as the edit page sends it; any field can be overridden. */
const form = (over: Record<string, string> = {}) => ({
  full_name: 'Renamed Admin',
  email: email('target'),
  role: 'moderator',
  status: 'active',
  new_password: '',
  confirm_password: '',
  ...over,
});

let boss: Fixture; // super_admin doing the editing
let target: { id: string; email: string };

beforeAll(async () => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  boss = await fixture('boss', 'super_admin');
});

beforeEach(async () => {
  // a fresh, signed-out target for every test
  await pool.query('DELETE FROM admin_accounts WHERE email = $1', [email('target')]);
  target = await createAdmin('target', 'moderator');
});

afterAll(async () => {
  // The target is re-created for every test, so the audit rows are found by their label (the e-mail), not by the account that is left.
  await pool.query(`DELETE FROM audit_logs WHERE target_label LIKE $1`, [`adm-${RUN}-%`]);
  await pool.query(`DELETE FROM admin_accounts WHERE email LIKE $1`, [`adm-${RUN}-%`]);
  jest.restoreAllMocks();
});

describe('who may open /admins', () => {
  it('sends a visitor who is not signed in to the sign-in page', async () => {
    const res = await request(app).get('/admins');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/auth/login');
  });

  it.each(['moderator', 'content_editor'] as const)('turns a %s away from the list, the form and the save', async (role) => {
    const other = await fixture(`other-${role}`, role);

    for (const res of [
      await other.agent.get('/admins'),
      await other.agent.get(`/admins/${target.id}/edit`),
      await other.agent.post(`/admins/${target.id}/edit`).type('form').send(form({ role: 'super_admin' })),
    ]) {
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/dashboard');
    }
    expect((await row(target.id)).role).toBe('moderator');
  });

  it('shows a super admin the list and the edit form', async () => {
    const list = await boss.agent.get('/admins');
    expect(list.status).toBe(200);
    expect(list.text).toContain(target.email);
    expect(list.text).toContain(`/admins/${target.id}/edit`);
    expect(list.text).not.toContain(`/admins/${boss.id}/edit`); // yourself: "My profile", not "Edit"

    const edit = await boss.agent.get(`/admins/${target.id}/edit`);
    expect(edit.status).toBe(200);
    expect(edit.text).toContain(target.email);
    expect(edit.text).not.toContain('password_hash');
  });

  it('gives only a super admin an Edit button on the dashboard', async () => {
    expect((await boss.agent.get('/dashboard')).text).toContain(`/admins/${target.id}/edit`);

    const mod = await fixture('dash-mod', 'moderator');
    const page = await mod.agent.get('/dashboard');
    expect(page.status).toBe(200);
    expect(page.text).not.toContain('/admins/');
  });
});

describe('POST /admins/:id/edit', () => {
  it('changes name, role, status and e-mail, and writes an audit row without the password', async () => {
    const res = await boss.agent
      .post(`/admins/${target.id}/edit`)
      .type('form')
      .send(form({ full_name: '  New Name ', email: `  ${email('renamed').toUpperCase()} `, role: 'content_editor', status: 'disabled' }));
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admins');

    const after = await row(target.id);
    expect(after).toMatchObject({ full_name: 'New Name', email: email('renamed'), role: 'content_editor', status: 'disabled' });

    const { rows } = await pool.query(`SELECT admin_id, action, module, target_label, details FROM audit_logs WHERE target_id = $1`, [target.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ admin_id: boss.id, action: 'UPDATE', module: 'admins', target_label: email('renamed') });
    expect(rows[0].details.password_reset).toBe(false);
    expect(rows[0].details.changes).toMatchObject({
      role: { from: 'moderator', to: 'content_editor' },
      status: { from: 'active', to: 'disabled' },
      full_name: { to: 'New Name' },
    });
    expect(JSON.stringify(rows[0].details)).not.toMatch(/password_hash|\$2[aby]\$/);
  });

  it('writes no audit row when nothing changed', async () => {
    const res = await boss.agent.post(`/admins/${target.id}/edit`).type('form').send(form({ full_name: `Adm target`, role: 'moderator' }));
    expect(res.headers.location).toBe('/admins');
    const { rows } = await pool.query(`SELECT 1 FROM audit_logs WHERE target_id = $1`, [target.id]);
    expect(rows).toHaveLength(0);
  });

  it.each([
    ['a name that is too short', { full_name: 'A' }],
    ['an e-mail that is not valid', { email: 'not-an-email' }],
    ['a role that does not exist', { role: 'owner' }],
    ['a status that does not exist', { status: 'banned' }],
    ['a password that is too short', { new_password: 'abc', confirm_password: 'abc' }],
    ['a password confirmation that differs', { new_password: 'abcdef1', confirm_password: 'abcdef2' }],
  ])('refuses %s and changes nothing', async (_name, over) => {
    const before = await row(target.id);
    const res = await boss.agent.post(`/admins/${target.id}/edit`).type('form').send(form(over));
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/admins/${target.id}/edit`);
    expect(await row(target.id)).toEqual(before);
  });

  it('refuses an e-mail that belongs to another account, however it is capitalised', async () => {
    const res = await boss.agent.post(`/admins/${target.id}/edit`).type('form').send(form({ email: boss.email.toUpperCase() }));
    expect(res.headers.location).toBe(`/admins/${target.id}/edit`);
    expect((await row(target.id)).email).toBe(target.email);
  });

  it('sends an unknown or malformed id back to the list', async () => {
    for (const id of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
      const get = await boss.agent.get(`/admins/${id}/edit`);
      const post = await boss.agent.post(`/admins/${id}/edit`).type('form').send(form());
      expect([get.headers.location, post.headers.location]).toEqual(['/admins', '/admins']);
    }
  });

  it('refuses a request that comes from another site', async () => {
    const res = await boss.agent
      .post(`/admins/${target.id}/edit`)
      .set('Origin', 'http://evil.example')
      .type('form')
      .send(form({ role: 'super_admin' }));
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/dashboard');
    expect((await row(target.id)).role).toBe('moderator');
  });
});

describe('your own account', () => {
  it('is edited on /profile: the admin pages send you there and change nothing', async () => {
    const before = await row(boss.id);
    const get = await boss.agent.get(`/admins/${boss.id}/edit`);
    const post = await boss.agent.post(`/admins/${boss.id}/edit`).type('form').send(form({ email: boss.email, role: 'moderator', status: 'disabled' }));
    expect([get.headers.location, post.headers.location]).toEqual(['/profile', '/profile']);
    expect(await row(boss.id)).toEqual(before);
  });
});

describe('password reset', () => {
  it('lets the edited admin sign in with the new password and not the old one', async () => {
    const res = await boss.agent
      .post(`/admins/${target.id}/edit`)
      .type('form')
      .send(form({ new_password: 'brand-new-pass', confirm_password: 'brand-new-pass' }));
    expect(res.headers.location).toBe('/admins');

    const old = await request(app).post('/auth/login').type('form').send({ email: target.email, password: PASSWORD });
    expect(old.headers.location).toBe('/auth/login');
    const fresh = await request(app).post('/auth/login').type('form').send({ email: target.email, password: 'brand-new-pass' });
    expect(fresh.headers.location).toBe('/dashboard');

    const { rows } = await pool.query(`SELECT details FROM audit_logs WHERE target_id = $1`, [target.id]);
    expect(rows[0].details.password_reset).toBe(true);
    expect(JSON.stringify(rows[0].details)).not.toContain('brand-new-pass');
  });

  it('keeps the old password when the boxes are empty', async () => {
    await boss.agent.post(`/admins/${target.id}/edit`).type('form').send(form({ full_name: 'Only the name' }));
    const login = await request(app).post('/auth/login').type('form').send({ email: target.email, password: PASSWORD });
    expect(login.headers.location).toBe('/dashboard');
  });
});

describe('sessions of the edited admin', () => {
  it('ends them when the account is disabled, and sign-in stays closed until it is enabled again', async () => {
    const victim = await signIn(target.email);
    expect((await victim.get('/dashboard')).status).toBe(200);

    await boss.agent.post(`/admins/${target.id}/edit`).type('form').send(form({ status: 'disabled' }));

    const after = await victim.get('/dashboard');
    expect(after.status).toBe(302);
    expect(after.headers.location).toBe('/auth/login');
    const blocked = await request(app).post('/auth/login').type('form').send({ email: target.email, password: PASSWORD });
    expect(blocked.headers.location).toBe('/auth/login');

    await boss.agent.post(`/admins/${target.id}/edit`).type('form').send(form({ status: 'active' }));
    expect((await signIn(target.email).then((a) => a.get('/dashboard'))).status).toBe(200);
  });

  it('ends them when the role changes, so a demoted super admin loses /admins at once', async () => {
    await pool.query(`UPDATE admin_accounts SET role = 'super_admin' WHERE id = $1`, [target.id]);
    const other = await signIn(target.email);
    expect((await other.get('/admins')).status).toBe(200);

    await boss.agent.post(`/admins/${target.id}/edit`).type('form').send(form({ role: 'moderator' }));

    const after = await other.get('/admins');
    expect(after.status).toBe(302);
    expect(after.headers.location).toBe('/auth/login');

    const again = await signIn(target.email);
    const gate = await again.get('/admins');
    expect(gate.status).toBe(302);
    expect(gate.headers.location).toBe('/dashboard');
  });

  it('ends them after a password reset', async () => {
    const victim = await signIn(target.email);
    await boss.agent.post(`/admins/${target.id}/edit`).type('form').send(form({ new_password: 'another-pass', confirm_password: 'another-pass' }));
    expect((await victim.get('/dashboard')).headers.location).toBe('/auth/login');
  });

  it('leaves them alone when only the name changes', async () => {
    const victim = await signIn(target.email);
    await boss.agent.post(`/admins/${target.id}/edit`).type('form').send(form({ full_name: 'Just a new name' }));
    expect((await victim.get('/dashboard')).status).toBe(200);
  });

  it('does not touch the sessions of other admins', async () => {
    const bystander = await fixture('bystander', 'moderator');
    await boss.agent.post(`/admins/${target.id}/edit`).type('form').send(form({ role: 'content_editor' }));
    expect((await bystander.agent.get('/dashboard')).status).toBe(200);
    expect((await boss.agent.get('/dashboard')).status).toBe(200);
  });
});

describe('Admin.updateByAdmin: the last active super admin', () => {
  // The caller is another active super admin, so in practice this only matters when two super admins edit each other at the same
  // moment; the check is tested with a fake connection because the shared database holds super admins that are not ours.
  function fakeConnection(supers: string[], target: Record<string, string>) {
    const log: string[] = [];
    const client = {
      release: jest.fn(),
      query: jest.fn(async (sql: string) => {
        const q = sql.replace(/\s+/g, ' ').trim();
        log.push(q.split(' ')[0]);
        if (q.startsWith("SELECT id FROM admin_accounts WHERE role = 'super_admin'")) return { rows: supers.map((id) => ({ id })) };
        if (q.startsWith('SELECT id, email, full_name, role, status')) return { rows: [target] };
        if (q.startsWith('SELECT 1 FROM admin_accounts')) return { rows: [] };
        if (q.startsWith('UPDATE admin_accounts')) return { rows: [{ ...target, role: 'moderator' }] };
        return { rows: [] };
      }),
    };
    jest.spyOn(pool, 'connect').mockResolvedValue(client as never);
    return { client, log };
  }

  const edit = { fullName: 'X', email: 'x@example.com', role: 'moderator', status: 'active' };
  const targetRow = { id: 'T', email: 'x@example.com', full_name: 'X', role: 'super_admin', status: 'active' };

  afterEach(() => jest.restoreAllMocks());

  it('refuses to demote the only active super admin and rolls back', async () => {
    const { log } = fakeConnection(['T'], targetRow);
    await expect(Admin.updateByAdmin('T', edit, { id: 'A' })).rejects.toMatchObject({ code: 'LAST_SUPER_ADMIN' });
    expect(log).toContain('ROLLBACK');
    expect(log).not.toContain('UPDATE');
  });

  it('refuses to disable the only active super admin', async () => {
    fakeConnection(['T'], targetRow);
    await expect(Admin.updateByAdmin('T', { ...edit, role: 'super_admin', status: 'disabled' }, { id: 'A' })).rejects.toMatchObject({
      code: 'LAST_SUPER_ADMIN',
    });
  });

  it('allows it while another active super admin remains', async () => {
    const { log } = fakeConnection(['A', 'T'], targetRow);
    await expect(Admin.updateByAdmin('T', edit, { id: 'A' })).resolves.toMatchObject({ after: { role: 'moderator' } });
    expect(log).toContain('COMMIT');
  });

  it('allows an edit that keeps the only super admin a super admin', async () => {
    fakeConnection(['T'], targetRow);
    await expect(Admin.updateByAdmin('T', { ...edit, role: 'super_admin' }, { id: 'A' })).resolves.toBeDefined();
  });
});
