// Every change is written to the append-only audit log in the same transaction as the change.
export async function audit(db, user, action, { entity = null, entityId = null, detail = null, before = null, after = null } = {}) {
  await db.query(
    `INSERT INTO audit_log (user_id, username, action, entity, entity_id, detail, before, after)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [user?.id ?? null, user?.username ?? 'system', action, entity, entityId == null ? null : String(entityId), detail,
      before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after)]);
}
