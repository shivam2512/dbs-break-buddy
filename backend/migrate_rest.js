/**
 * Migration Script: Render PostgreSQL → Supabase (via REST API)
 * Run: node migrate_rest.js
 */

const { Pool } = require('pg');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://himqkriqwaeaohqszxmm.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_KEY) {
    console.error('❌ SUPABASE_SERVICE_ROLE_KEY env var is required');
    process.exit(1);
}

const RENDER_URL = process.env.RENDER_DB_URL;
if (!RENDER_URL) {
    console.error('❌ RENDER_DB_URL env var is required');
    process.exit(1);
}

const renderPool = new Pool({
    connectionString: RENDER_URL,
    ssl: { rejectUnauthorized: false }
});

const HEADERS = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal,resolution=merge-duplicates'
};

async function supabaseInsert(table, rows) {
    if (rows.length === 0) return;
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
        method: 'POST',
        headers: {
            ...HEADERS,
            'Prefer': 'return=minimal,resolution=merge-duplicates'
        },
        body: JSON.stringify(rows)
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Failed to insert into ${table}: ${err}`);
    }
}

async function supabaseRpc(func, args = {}) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${func}`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(args)
    });
    return res;
}

async function migrate() {
    console.log('🚀 Starting migration: Render → Supabase (via REST API)\n');

    try {
        // ───── STEP 1: Read data from Render ─────
        console.log('📥 Step 1: Reading data from Render...');

        const empResult = await renderPool.query('SELECT * FROM employees ORDER BY id');
        const logsResult = await renderPool.query('SELECT * FROM break_logs ORDER BY id');
        const adminResult = await renderPool.query('SELECT * FROM admin ORDER BY id');

        const employees = empResult.rows;
        const logs = logsResult.rows;
        const admins = adminResult.rows;

        console.log(`   Found: ${employees.length} employees, ${logs.length} break logs, ${admins.length} admin accounts\n`);

        // ───── STEP 2: Migrate employees ─────
        console.log('👥 Step 2: Migrating employees...');
        if (employees.length > 0) {
            await supabaseInsert('employees', employees.map(e => ({
                id: e.id,
                emp_id: e.emp_id,
                name: e.name
            })));
        }
        console.log(`✅ ${employees.length} employees migrated\n`);

        // ───── STEP 3: Migrate break_logs ─────
        console.log('📋 Step 3: Migrating break logs...');
        // Insert in batches of 100
        const BATCH = 100;
        for (let i = 0; i < logs.length; i += BATCH) {
            const batch = logs.slice(i, i + BATCH).map(l => ({
                id: l.id,
                emp_id: l.emp_id,
                employee_name: l.employee_name,
                reason: l.reason,
                extra_reason: l.extra_reason,
                start_time: l.start_time,
                end_time: l.end_time,
                duration: l.duration,
                ended_by: l.ended_by
            }));
            await supabaseInsert('break_logs', batch);
            console.log(`   Inserted batch ${Math.floor(i/BATCH)+1}: ${batch.length} rows`);
        }
        console.log(`✅ ${logs.length} break log entries migrated\n`);

        // ───── STEP 4: Migrate admin ─────
        console.log('🔐 Step 4: Migrating admin accounts...');
        if (admins.length > 0) {
            await supabaseInsert('admin', admins.map(a => ({
                id: a.id,
                username: a.username,
                password: a.password
            })));
        }
        console.log(`✅ ${admins.length} admin accounts migrated\n`);

        // ───── STEP 5: Verify ─────
        console.log('🔍 Step 5: Verifying on Supabase...');
        const [eRes, lRes, aRes] = await Promise.all([
            fetch(`${SUPABASE_URL}/rest/v1/employees?select=count`, { headers: { ...HEADERS, 'Prefer': 'count=exact' } }),
            fetch(`${SUPABASE_URL}/rest/v1/break_logs?select=count`, { headers: { ...HEADERS, 'Prefer': 'count=exact' } }),
            fetch(`${SUPABASE_URL}/rest/v1/admin?select=count`, { headers: { ...HEADERS, 'Prefer': 'count=exact' } }),
        ]);

        const eCount = eRes.headers.get('content-range') || 'unknown';
        const lCount = lRes.headers.get('content-range') || 'unknown';
        const aCount = aRes.headers.get('content-range') || 'unknown';

        console.log(`   ✅ Supabase employees: ${eCount}`);
        console.log(`   ✅ Supabase break_logs: ${lCount}`);
        console.log(`   ✅ Supabase admin: ${aCount}`);

        console.log('\n🎉 Migration completed successfully!');

    } catch (err) {
        console.error('\n❌ Migration failed:', err.message);
        process.exit(1);
    } finally {
        await renderPool.end();
    }
}

migrate();
