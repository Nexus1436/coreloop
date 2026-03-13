#!/bin/bash
# migrate_helium_to_neon_v2.sh
# Fixed version — uses correct Helium column names
# Safe to run multiple times — uses INSERT ... ON CONFLICT DO NOTHING

HELIUM="postgresql://postgres:password@helium/heliumdb"
NEON="postgresql://neondb_owner:npg_Zg0Iz1vpPNHr@ep-broad-morning-a597h3q8.us-east-2.aws.neon.tech/neondb"

echo "=== Interloop: Helium → Neon Migration v2 ==="
echo ""

# ── 1. USERS ──────────────────────────────────────────────────────────────────
echo "Migrating users..."
psql "$HELIUM" -t -A -c \
  "COPY (SELECT id, email, first_name, last_name, profile_image_url, created_at FROM users ORDER BY created_at) TO STDOUT WITH (FORMAT csv, FORCE_QUOTE *);" \
| psql "$NEON" -c \
  "CREATE TEMP TABLE tmp_users (id varchar, email varchar, first_name varchar, last_name varchar, profile_image_url varchar, created_at timestamp);
   COPY tmp_users FROM STDIN WITH (FORMAT csv, FORCE_QUOTE *);
   INSERT INTO users (id, email, first_name, last_name, profile_image_url, created_at)
   SELECT id, email, first_name, last_name, profile_image_url, created_at FROM tmp_users
   ON CONFLICT (id) DO NOTHING;"
echo "  ✓ users done"

# ── 2. CONVERSATIONS ──────────────────────────────────────────────────────────
echo "Migrating conversations..."
psql "$HELIUM" -t -A -c \
  "COPY (SELECT id, user_id, title, summary, created_at FROM conversations ORDER BY id) TO STDOUT WITH (FORMAT csv, FORCE_QUOTE *);" \
| psql "$NEON" -c \
  "CREATE TEMP TABLE tmp_conversations (id int, user_id text, title text, summary text, created_at timestamp);
   COPY tmp_conversations FROM STDIN WITH (FORMAT csv, FORCE_QUOTE *);
   INSERT INTO conversations (id, user_id, title, summary, created_at)
   SELECT id, user_id, title, summary, created_at FROM tmp_conversations
   ON CONFLICT (id) DO NOTHING;"
echo "  ✓ conversations done"

# ── 3. MESSAGES ───────────────────────────────────────────────────────────────
echo "Migrating messages..."
psql "$HELIUM" -t -A -c \
  "COPY (SELECT id, conversation_id, role, content, created_at FROM messages ORDER BY id) TO STDOUT WITH (FORMAT csv, FORCE_QUOTE *);" \
| psql "$NEON" -c \
  "CREATE TEMP TABLE tmp_messages (id int, conversation_id int, role text, content text, created_at timestamp);
   COPY tmp_messages FROM STDIN WITH (FORMAT csv, FORCE_QUOTE *);
   INSERT INTO messages (id, conversation_id, role, content, created_at)
   SELECT id, conversation_id, role, content, created_at FROM tmp_messages
   ON CONFLICT (id) DO NOTHING;"
echo "  ✓ messages done"

# ── 4. RESET SEQUENCES ────────────────────────────────────────────────────────
echo "Resetting sequences..."
psql "$NEON" -c "
  SELECT setval('conversations_id_seq', (SELECT MAX(id) FROM conversations));
  SELECT setval('messages_id_seq', (SELECT MAX(id) FROM messages));
" > /dev/null 2>&1
echo "  ✓ sequences reset"

# ── VERIFY ────────────────────────────────────────────────────────────────────
echo ""
echo "=== Verification: Row counts ==="
echo "--- Helium ---"
psql "$HELIUM" -c "
  SELECT 'users' as table_name, COUNT(*) FROM users
  UNION ALL SELECT 'conversations', COUNT(*) FROM conversations
  UNION ALL SELECT 'messages', COUNT(*) FROM messages
  ORDER BY 1;"

echo ""
echo "--- Neon ---"
psql "$NEON" -c "
  SELECT 'users' as table_name, COUNT(*) FROM users
  UNION ALL SELECT 'conversations', COUNT(*) FROM conversations
  UNION ALL SELECT 'messages', COUNT(*) FROM messages
  ORDER BY 1;"

echo ""
echo "=== Migration v2 complete. Helium is untouched. ==="