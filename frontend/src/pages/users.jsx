// Users administration — list, create, edit (rename / reset password /
// disable), assign-or-remove roles, delete. Wired to /v1/admin/users.

import React, { useState, useEffect, useMemo } from 'react';
import { Ti, PageHead, Modal, hasPermission, permLock } from '../components/shell.jsx';
import { SearchInput } from '../components/search-input.jsx';
import {
  listUsers,
  listRoles,
  createUser,
  updateUser,
  deleteUser as apiDeleteUser,
  assignUserRole,
  unassignUserRole,
} from '../api/client.js';

function Users({ toast, currentUser, user }) {
  const me = user || currentUser;
  const canCreate = hasPermission(me, 'users:create');
  const canUpdate = hasPermission(me, 'users:update');
  const canDelete = hasPermission(me, 'users:delete');
  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const refresh = async () => {
    const [u, r] = await Promise.all([listUsers(), listRoles()]);
    setUsers(Array.isArray(u) ? u : []);
    setRoles(Array.isArray(r) ? r : []);
    setLoading(false);
  };

  useEffect(() => {
    refresh();
  }, []);

  const filtered = useMemo(() => {
    if (!search) return users;
    const q = search.toLowerCase();
    return users.filter(
      (u) =>
        (u.username || '').toLowerCase().includes(q) ||
        (u.fullName || '').toLowerCase().includes(q) ||
        (u.email || '').toLowerCase().includes(q),
    );
  }, [users, search]);

  const handleCreate = async (form) => {
    try {
      const created = await createUser(form);
      setUsers((u) => [created, ...u]);
      setCreateOpen(false);
      toast(`Created user ${created.username}`, 'success');
    } catch (err) {
      toast(`Create failed: ${parseErrorMessage(err)}`, 'danger');
    }
  };

  const handleUpdate = async (id, patch) => {
    try {
      const updated = await updateUser(id, patch);
      setUsers((u) => u.map((row) => (row.id === id ? updated : row)));
      setEditing(null);
      toast('User updated', 'success');
    } catch (err) {
      toast(`Update failed: ${parseErrorMessage(err)}`, 'danger');
    }
  };

  const handleDelete = async (user) => {
    try {
      await apiDeleteUser(user.id);
      setUsers((u) => u.filter((row) => row.id !== user.id));
      setConfirmDelete(null);
      toast(`Deleted ${user.username}`, 'danger');
    } catch (err) {
      toast(`Delete failed: ${parseErrorMessage(err)}`, 'danger');
    }
  };

  const handleAssign = async (user, roleId) => {
    try {
      const updated = await assignUserRole(user.id, roleId);
      setUsers((u) => u.map((row) => (row.id === user.id ? updated : row)));
      toast(`Role assigned to ${user.username}`, 'success');
    } catch (err) {
      toast(`Assign failed: ${parseErrorMessage(err)}`, 'danger');
    }
  };

  const handleUnassign = async (user, roleId) => {
    try {
      const updated = await unassignUserRole(user.id, roleId);
      setUsers((u) => u.map((row) => (row.id === user.id ? updated : row)));
      toast(`Role removed from ${user.username}`);
    } catch (err) {
      toast(`Remove failed: ${parseErrorMessage(err)}`, 'danger');
    }
  };

  return (
    <>
      <PageHead
        crumbs={['Dashboard', 'Access']}
        title="Users"
        sub={`${users.length} user${users.length === 1 ? '' : 's'} · admin = SUPER_ADMIN`}
      >
        <button onClick={refresh} title="Refresh">
          <Ti name="refresh" size={14} />
        </button>
        <button
          className="info-bg"
          onClick={() => setCreateOpen(true)}
          {...permLock(me, 'users:create')}
        >
          <Ti name="plus" size={14} />
          New user
        </button>
      </PageHead>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <SearchInput
          value={search}
          onCommit={setSearch}
          placeholder="Search username / full name / email (press Enter)"
        />
      </div>

      <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
        <div
          className="row-grid header"
          style={{
            gridTemplateColumns: 'minmax(0,1.4fr) minmax(0,1.4fr) 1fr 70px 28px',
            padding: 'calc(var(--row-pad-y, 9px) * 0.7) 14px',
          }}
        >
          <span>USER</span>
          <span>ROLES</span>
          <span>EMAIL</span>
          <span>STATUS</span>
          <span></span>
        </div>
        {loading && (
          <div
            style={{
              padding: 40,
              textAlign: 'center',
              fontSize: 12,
              color: 'var(--color-text-tertiary)',
            }}
          >
            Loading…
          </div>
        )}
        {!loading && filtered.length === 0 && (
          <div
            style={{
              padding: 40,
              textAlign: 'center',
              fontSize: 12,
              color: 'var(--color-text-tertiary)',
            }}
          >
            {users.length === 0 ? 'No users yet.' : 'No users match this search.'}
          </div>
        )}
        {filtered.map((u) => (
          <UserRow
            key={u.id}
            user={u}
            roles={roles}
            isSelf={currentUser?.id === u.id}
            canUpdate={canUpdate}
            canDelete={canDelete}
            onEdit={() => setEditing(u)}
            onDelete={() => setConfirmDelete(u)}
            onAssign={(roleId) => handleAssign(u, roleId)}
            onUnassign={(roleId) => handleUnassign(u, roleId)}
          />
        ))}
      </div>

      {createOpen && (
        <CreateUserModal
          roles={roles}
          onClose={() => setCreateOpen(false)}
          onSubmit={handleCreate}
        />
      )}
      {editing && (
        <EditUserModal
          user={editing}
          onClose={() => setEditing(null)}
          onSubmit={(patch) => handleUpdate(editing.id, patch)}
        />
      )}
      {confirmDelete && (
        <Modal
          title="Delete user"
          sub={
            <>
              This permanently removes <code className="mono">{confirmDelete.username}</code> and
              all their role assignments. Audit rows attributable to them stay intact.
            </>
          }
          onClose={() => setConfirmDelete(null)}
          footer={
            <>
              <button onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className="danger-bg" onClick={() => handleDelete(confirmDelete)}>
                Delete
              </button>
            </>
          }
        >
          <p style={{ margin: 0, fontSize: 12 }}>
            Are you sure? Deletion cannot be undone — disable instead if you may need to restore access.
          </p>
        </Modal>
      )}
    </>
  );
}

function UserRow({ user, roles, isSelf, canUpdate, canDelete, onEdit, onDelete, onAssign, onUnassign }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [showAssign, setShowAssign] = useState(false);

  const assigned = new Set((user.roles || []).map((r) => r.id));
  const available = roles.filter((r) => !assigned.has(r.id));

  return (
    <div
      className="row-grid"
      style={{
        gridTemplateColumns: 'minmax(0,1.4fr) minmax(0,1.4fr) 1fr 70px 28px',
        padding: 'var(--row-pad-y, 9px) 14px',
        opacity: user.isActive ? 1 : 0.6,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <p style={{ margin: 0, fontSize: 13, fontWeight: 500 }} className="truncate">
          {user.fullName || user.username}
          {isSelf && (
            <span
              className="pill"
              style={{ marginLeft: 6, padding: '1px 6px', fontSize: 9 }}
            >
              you
            </span>
          )}
        </p>
        <p
          style={{ margin: '1px 0 0', fontSize: 11, color: 'var(--color-text-secondary)' }}
          className="truncate"
        >
          <code className="mono">{user.username}</code>
        </p>
      </div>

      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', minWidth: 0 }}>
        {(user.roles || []).length === 0 && (
          <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>none</span>
        )}
        {(user.roles || []).map((r) => (
          <span
            key={r.id}
            className="pill"
            style={{
              padding: '2px 7px',
              gap: 4,
              fontSize: 10,
              display: 'inline-flex',
              alignItems: 'center',
            }}
            title={r.name}
          >
            {r.name}
            {(user.roles || []).length > 1 && !isSelf && canUpdate && (
              <Ti
                name="x"
                size={10}
                style={{ cursor: 'pointer', opacity: 0.7 }}
                onClick={() => onUnassign(r.id)}
              />
            )}
          </span>
        ))}
        {available.length > 0 && canUpdate && (
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => setShowAssign((o) => !o)}
              style={{ padding: '2px 6px', fontSize: 10 }}
              title="Assign role"
            >
              <Ti name="plus" size={10} />
            </button>
            {showAssign && (
              <div
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 'calc(100% + 4px)',
                  zIndex: 20,
                  background: 'var(--color-background-primary)',
                  border: '0.5px solid var(--color-border-tertiary)',
                  borderRadius: 'var(--border-radius-md)',
                  boxShadow: 'var(--shadow-md)',
                  minWidth: 180,
                  padding: 4,
                  fontSize: 12,
                }}
                onMouseLeave={() => setShowAssign(false)}
              >
                {available.map((r) => (
                  <div
                    key={r.id}
                    style={{ padding: '6px 10px', borderRadius: 4, cursor: 'pointer' }}
                    onClick={() => {
                      setShowAssign(false);
                      onAssign(r.id);
                    }}
                    onMouseEnter={(e) =>
                      (e.currentTarget.style.background = 'var(--color-background-secondary)')
                    }
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    {r.name}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <p
        style={{ margin: 0, fontSize: 11, color: 'var(--color-text-secondary)' }}
        className="truncate"
      >
        {user.email || '—'}
      </p>

      <span
        className={'pill round ' + (user.isActive ? 'success' : '')}
        style={{ justifySelf: 'start' }}
      >
        {user.isActive ? 'active' : 'disabled'}
      </span>

      <div style={{ position: 'relative' }}>
        <button
          className="ghost icon-only"
          onClick={() => setMenuOpen((o) => !o)}
          aria-label="Actions"
        >
          <Ti name="dots-vertical" size={14} />
        </button>
        {menuOpen && (
          <div
            onMouseLeave={() => setMenuOpen(false)}
            style={{
              position: 'absolute',
              right: 0,
              top: 'calc(100% + 4px)',
              zIndex: 20,
              background: 'var(--color-background-primary)',
              border: '0.5px solid var(--color-border-tertiary)',
              borderRadius: 'var(--border-radius-md)',
              boxShadow: 'var(--shadow-md)',
              minWidth: 160,
              padding: 4,
              fontSize: 12,
            }}
          >
            <MenuItem
              icon="edit"
              onClick={() => { setMenuOpen(false); onEdit(); }}
              disabled={!canUpdate}
              hint={canUpdate ? '' : 'Requires "users:update" — ask an administrator.'}
            >
              Edit / Reset password
            </MenuItem>
            {!isSelf && (
              <MenuItem
                icon="trash"
                tone="danger"
                onClick={() => { setMenuOpen(false); onDelete(); }}
                disabled={!canDelete}
                hint={canDelete ? '' : 'Requires "users:delete" — ask an administrator.'}
              >
                Delete
              </MenuItem>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function MenuItem({ icon, children, onClick, tone, disabled, hint }) {
  const color = disabled
    ? 'var(--color-text-quaternary)'
    : tone === 'danger'
    ? 'var(--color-text-danger)'
    : 'inherit';
  return (
    <div
      onClick={disabled ? undefined : onClick}
      title={hint || ''}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        borderRadius: 4,
        cursor: disabled ? 'not-allowed' : 'pointer',
        color,
      }}
      onMouseEnter={(e) => {
        if (!disabled)
          e.currentTarget.style.background = 'var(--color-background-secondary)';
      }}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <Ti name={icon} size={12} />
      <span style={{ flex: 1 }}>{children}</span>
      {disabled && <Ti name="lock" size={10} />}
    </div>
  );
}

function CreateUserModal({ roles, onClose, onSubmit }) {
  const [form, setForm] = useState({
    username: '',
    password: '',
    fullName: '',
    email: '',
    roleIds: [],
  });
  const valid =
    form.username.trim().length > 0 && form.password.length >= 8;

  return (
    <Modal
      title="Add a new user"
      sub={
        <>
          Pick a username, set their starting password, and choose at least
          one role — that's what controls which parts of Sentinel they can
          see and change.
        </>
      }
      onClose={onClose}
      width={520}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!valid} onClick={() => onSubmit(form)}>
            Create user
          </button>
        </>
      }
    >
      <Field
        label="Username"
        hint="Used to sign in. Lowercase letters, numbers and dashes."
      >
        <input
          autoFocus
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={form.username}
          onChange={(e) =>
            setForm({ ...form, username: e.target.value.toLowerCase() })
          }
          placeholder="e.g. ayodeji"
        />
      </Field>
      <Field
        label="Starting password"
        hint="At least 8 characters. The user can change it any time after signing in."
      >
        <input
          type="password"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
        />
      </Field>
      <Field label="Full name">
        <input
          value={form.fullName}
          onChange={(e) => setForm({ ...form, fullName: e.target.value })}
          placeholder="Ayodeji Abodunrin"
        />
      </Field>
      <Field label="Email">
        <input
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          placeholder="name@example.com"
        />
      </Field>
      <Field label="Roles">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {roles.map((r) => {
            const on = form.roleIds.includes(r.id);
            return (
              <label
                key={r.id}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '4px 8px',
                  border: '0.5px solid var(--color-border-secondary)',
                  borderRadius: 'var(--border-radius-md)',
                  cursor: 'pointer',
                  fontSize: 11,
                  background: on ? 'var(--color-background-info)' : 'transparent',
                  color: on ? 'var(--color-text-info)' : 'var(--color-text-primary)',
                }}
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() =>
                    setForm((f) => ({
                      ...f,
                      roleIds: on
                        ? f.roleIds.filter((x) => x !== r.id)
                        : [...f.roleIds, r.id],
                    }))
                  }
                  style={{ display: 'none' }}
                />
                {on && <Ti name="check" size={10} />}
                {r.name}
              </label>
            );
          })}
          {roles.length === 0 && (
            <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
              No roles available — create one on the Roles page first.
            </span>
          )}
        </div>
      </Field>
    </Modal>
  );
}

function EditUserModal({ user, onClose, onSubmit }) {
  const [form, setForm] = useState({
    fullName: user.fullName || '',
    email: user.email || '',
    password: '',
    isActive: user.isActive,
  });
  return (
    <Modal
      title={`Edit ${user.username}`}
      sub={
        <>
          Leave the password blank to keep it unchanged. Disabling a user
          revokes any future logins; existing JWTs expire on their own.
        </>
      }
      onClose={onClose}
      width={500}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            onClick={() => {
              const patch = {};
              if (form.fullName !== (user.fullName || '')) patch.fullName = form.fullName || null;
              if (form.email !== (user.email || '')) patch.email = form.email || null;
              if (form.password) patch.password = form.password;
              if (form.isActive !== user.isActive) patch.isActive = form.isActive;
              if (Object.keys(patch).length === 0) {
                onClose();
                return;
              }
              onSubmit(patch);
            }}
          >
            Save
          </button>
        </>
      }
    >
      <Field label="Full name">
        <input
          value={form.fullName}
          onChange={(e) => setForm({ ...form, fullName: e.target.value })}
        />
      </Field>
      <Field label="Email">
        <input
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
        />
      </Field>
      <Field label="New password" hint="Leave blank to keep the current password.">
        <input
          type="password"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
          placeholder="••••••••"
        />
      </Field>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
        <div
          className={'toggle ' + (form.isActive ? 'on' : '')}
          onClick={() => setForm({ ...form, isActive: !form.isActive })}
        />
        <span style={{ fontSize: 12 }}>Active</span>
      </div>
    </Modal>
  );
}

function Field({ label, hint, children }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <label className="label-up" style={{ display: 'block', marginBottom: 4 }}>
        {label}
      </label>
      {React.cloneElement(children, {
        style: { width: '100%', ...(children.props.style || {}) },
      })}
      {hint && (
        <p style={{ margin: '4px 0 0', fontSize: 10, color: 'var(--color-text-tertiary)' }}>
          {hint}
        </p>
      )}
    </div>
  );
}

function parseErrorMessage(err) {
  const m = String(err?.message || err);
  // The unwrap helper formats errors as "<status> <statusText>: <body>".
  // Pull a server `message` field out of the body when present.
  const bodyStart = m.indexOf('{');
  if (bodyStart >= 0) {
    try {
      const obj = JSON.parse(m.slice(bodyStart));
      if (obj && typeof obj.message === 'string') return obj.message;
    } catch {
      /* fallthrough */
    }
  }
  return m;
}

export default Users;
