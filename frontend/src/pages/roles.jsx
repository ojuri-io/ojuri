// Roles administration — list system + custom roles, create new custom
// roles with a permission picker fed by /v1/admin/permissions, edit and
// delete (system roles are read-only / un-deletable per the backend).

import React, { useState, useEffect, useMemo } from 'react';
import { Ti, PageHead, Modal, hasPermission, permLock } from '../components/shell.jsx';
import {
  listRoles,
  listPermissions,
  createRole,
  updateRole,
  deleteRole as apiDeleteRole,
} from '../api/client.js';

function Roles({ toast, user }) {
  const canUpdate = hasPermission(user, 'roles:update');
  const canDelete = hasPermission(user, 'roles:delete');
  const [roles, setRoles] = useState([]);
  const [permissions, setPermissions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const refresh = async () => {
    const [r, p] = await Promise.all([listRoles(), listPermissions()]);
    setRoles(Array.isArray(r) ? r : []);
    setPermissions(Array.isArray(p) ? p : []);
    setLoading(false);
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleCreate = async (form) => {
    try {
      const created = await createRole(form);
      setRoles((rs) => [...rs, created]);
      setCreateOpen(false);
      toast(`Created role ${created.name}`, 'success');
    } catch (err) {
      toast(`Create failed: ${parseError(err)}`, 'danger');
    }
  };

  const handleUpdate = async (id, patch) => {
    try {
      const updated = await updateRole(id, patch);
      setRoles((rs) => rs.map((r) => (r.id === id ? updated : r)));
      setEditing(null);
      toast('Role updated', 'success');
    } catch (err) {
      toast(`Update failed: ${parseError(err)}`, 'danger');
    }
  };

  const handleDelete = async (role) => {
    try {
      await apiDeleteRole(role.id);
      setRoles((rs) => rs.filter((r) => r.id !== role.id));
      setConfirmDelete(null);
      toast(`Deleted ${role.name}`, 'danger');
    } catch (err) {
      toast(`Delete failed: ${parseError(err)}`, 'danger');
    }
  };

  return (
    <>
      <PageHead
        crumbs={['Dashboard', 'Access']}
        title="Roles"
        sub={`${roles.length} role${roles.length === 1 ? '' : 's'} · ${permissions.length} permissions in catalogue`}
      >
        <button onClick={refresh} title="Refresh">
          <Ti name="refresh" size={14} />
        </button>
        <button
          className="info-bg"
          onClick={() => setCreateOpen(true)}
          {...permLock(user, 'roles:create')}
        >
          <Ti name="plus" size={14} />
          New role
        </button>
      </PageHead>

      {loading && (
        <div
          className="panel"
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

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {roles.map((r) => (
          <RoleCard
            key={r.id}
            role={r}
            canUpdate={canUpdate}
            canDelete={canDelete}
            onEdit={() => setEditing(r)}
            onDelete={() => setConfirmDelete(r)}
          />
        ))}
      </div>

      {createOpen && (
        <CreateRoleModal
          permissions={permissions}
          onClose={() => setCreateOpen(false)}
          onSubmit={handleCreate}
        />
      )}
      {editing && (
        <EditRoleModal
          role={editing}
          permissions={permissions}
          onClose={() => setEditing(null)}
          onSubmit={(patch) => handleUpdate(editing.id, patch)}
        />
      )}
      {confirmDelete && (
        <Modal
          title={`Delete role "${confirmDelete.name}"`}
          sub={
            <>
              Users currently holding this role will lose its permissions on
              their next login.
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
            This cannot be undone. System roles cannot be deleted at all — the
            server returns 409 for those.
          </p>
        </Modal>
      )}
    </>
  );
}

function RoleCard({ role, canUpdate, canDelete, onEdit, onDelete }) {
  const hasWildcard = (role.permissions || []).includes('*');
  return (
    <article className="panel" style={{ padding: '14px 16px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 10,
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
            {role.name}
            {role.isSystem && (
              <span className="pill" style={{ padding: '1px 6px', fontSize: 9 }}>
                SYSTEM
              </span>
            )}
            {hasWildcard && (
              <span className="pill danger" style={{ padding: '1px 6px', fontSize: 9 }}>
                ALL PERMS
              </span>
            )}
          </p>
          <p
            style={{
              margin: '3px 0 0',
              fontSize: 11,
              color: 'var(--color-text-secondary)',
            }}
          >
            {role.description || 'No description'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            onClick={onEdit}
            style={{ padding: '4px 8px', fontSize: 11 }}
            disabled={(role.isSystem && hasWildcard) || !canUpdate}
            title={
              !canUpdate
                ? 'Requires "roles:update" — ask an administrator.'
                : role.isSystem && hasWildcard
                ? 'SUPER_ADMIN is read-only'
                : ''
            }
          >
            <Ti name="edit" size={12} />
            Edit
          </button>
          <button
            onClick={onDelete}
            disabled={role.isSystem || !canDelete}
            title={
              role.isSystem
                ? 'System roles cannot be deleted'
                : !canDelete
                ? 'Requires "roles:delete" — ask an administrator.'
                : ''
            }
            style={{
              padding: '4px 8px',
              fontSize: 11,
              color:
                role.isSystem || !canDelete ? undefined : 'var(--color-text-danger)',
            }}
          >
            <Ti name="trash" size={12} />
          </button>
        </div>
      </div>

      <p
        className="label-up"
        style={{ margin: '0 0 6px', fontSize: 10 }}
      >
        PERMISSIONS · {(role.permissions || []).length}
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {(role.permissions || []).map((p) => (
          <span
            key={p}
            className="mono"
            style={{
              fontSize: 10,
              background: 'var(--color-background-secondary)',
              padding: '2px 7px',
              borderRadius: 3,
              color:
                p === '*' ? 'var(--color-text-danger)' : 'var(--color-text-secondary)',
            }}
          >
            {p}
          </span>
        ))}
      </div>
    </article>
  );
}

function CreateRoleModal({ permissions, onClose, onSubmit }) {
  return (
    <RoleFormModal
      title="Create role"
      sub={
        <>
          Custom roles can be granted any subset of the permission catalogue.
          The wildcard <code className="mono">*</code> is reserved for the
          system <code className="mono">SUPER_ADMIN</code> role and cannot be
          assigned to a custom role.
        </>
      }
      initial={{ name: '', description: '', permissions: [] }}
      permissions={permissions}
      onClose={onClose}
      onSubmit={onSubmit}
    />
  );
}

function EditRoleModal({ role, permissions, onClose, onSubmit }) {
  return (
    <RoleFormModal
      title={`Edit "${role.name}"`}
      sub={
        role.isSystem ? (
          <>System roles can only have their description and permissions edited (not their name).</>
        ) : (
          <>
            Changes take effect on each user's next login — JWTs already issued keep
            their original permissions until they expire.
          </>
        )
      }
      initial={{
        name: role.name,
        description: role.description || '',
        permissions: role.permissions || [],
      }}
      permissions={permissions}
      onClose={onClose}
      onSubmit={onSubmit}
      lockName={role.isSystem}
    />
  );
}

function RoleFormModal({ title, sub, initial, permissions, onClose, onSubmit, lockName }) {
  const [form, setForm] = useState(initial);

  // Permissions in the catalogue grouped by their `<resource>:<action>` prefix
  // so the picker is browsable. Stable across renders.
  const groups = useMemo(() => {
    const g = new Map();
    for (const p of permissions) {
      const [resource] = (p.code || '').split(':');
      if (!g.has(resource)) g.set(resource, []);
      g.get(resource).push(p);
    }
    return [...g.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [permissions]);

  const toggle = (code) =>
    setForm((f) => ({
      ...f,
      permissions: f.permissions.includes(code)
        ? f.permissions.filter((c) => c !== code)
        : [...f.permissions, code],
    }));

  const toggleGroup = (group, on) => {
    const codes = group.map((p) => p.code);
    setForm((f) => {
      const without = f.permissions.filter((c) => !codes.includes(c));
      return { ...f, permissions: on ? [...without, ...codes] : without };
    });
  };

  const valid =
    form.name.trim().length > 0 && form.permissions.length > 0;

  return (
    <Modal
      title={title}
      sub={sub}
      onClose={onClose}
      width={620}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={!valid}
            onClick={() =>
              onSubmit({
                name: lockName ? undefined : form.name,
                description: form.description,
                permissions: form.permissions,
              })
            }
          >
            Save
          </button>
        </>
      }
    >
      <Field label="Name">
        <input
          autoFocus={!lockName}
          disabled={lockName}
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="MODEL_REVIEWER"
        />
      </Field>
      <Field label="Description">
        <textarea
          rows={2}
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          placeholder="What this role is allowed to do"
          style={{ resize: 'vertical' }}
        />
      </Field>

      <p
        className="label-up"
        style={{ margin: '14px 0 6px' }}
      >
        PERMISSIONS · {form.permissions.length} selected
      </p>
      <div
        style={{
          maxHeight: 320,
          overflow: 'auto',
          border: '0.5px solid var(--color-border-tertiary)',
          borderRadius: 'var(--border-radius-md)',
          padding: 8,
          background: 'var(--color-background-secondary)',
        }}
      >
        {groups.length === 0 && (
          <div
            style={{
              padding: 16,
              fontSize: 11,
              color: 'var(--color-text-tertiary)',
              textAlign: 'center',
            }}
          >
            Could not load the permission catalogue — is the backend
            reachable?
          </div>
        )}
        {groups.map(([resource, list]) => {
          const codes = list.map((p) => p.code);
          const selectedInGroup = codes.filter((c) => form.permissions.includes(c)).length;
          const allOn = selectedInGroup === codes.length;
          return (
            <div key={resource} style={{ marginBottom: 8 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '4px 6px',
                }}
              >
                <span
                  className="label-up"
                  style={{ fontSize: 10, letterSpacing: '0.06em' }}
                >
                  {resource}
                </span>
                <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>
                  {selectedInGroup}/{codes.length}
                </span>
                <span className="spacer" />
                <button
                  style={{ padding: '2px 6px', fontSize: 10 }}
                  onClick={() => toggleGroup(list, !allOn)}
                >
                  {allOn ? 'Unselect all' : 'Select all'}
                </button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, padding: '0 6px' }}>
                {list.map((p) => {
                  const on = form.permissions.includes(p.code);
                  return (
                    <label
                      key={p.code}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 6,
                        padding: '5px 8px',
                        borderRadius: 4,
                        cursor: 'pointer',
                        background: on
                          ? 'color-mix(in srgb, var(--color-background-info) 60%, transparent)'
                          : 'transparent',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => toggle(p.code)}
                        style={{ marginTop: 2 }}
                      />
                      <div style={{ minWidth: 0 }}>
                        <code
                          className="mono"
                          style={{
                            fontSize: 10,
                            color: on ? 'var(--color-text-info)' : 'var(--color-text-primary)',
                          }}
                        >
                          {p.code}
                        </code>
                        <p
                          style={{
                            margin: 0,
                            fontSize: 10,
                            color: 'var(--color-text-tertiary)',
                            lineHeight: 1.4,
                          }}
                        >
                          {p.description}
                        </p>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <label className="label-up" style={{ display: 'block', marginBottom: 4 }}>
        {label}
      </label>
      {React.cloneElement(children, {
        style: { width: '100%', ...(children.props.style || {}) },
      })}
    </div>
  );
}

function parseError(err) {
  const m = String(err?.message || err);
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

export default Roles;
