/**
 * Migration Script: Render PostgreSQL → Supabase PostgreSQL
 * Run: node migrate_to_supabase.js
 */

const { Pool } = require('pg');

const RENDER_URL = process.env.RENDER_DB_URL || 'postgresql://breakbuddy_db_zbn3_user:tXvYt19q4rHCH35o2dybFsHRMLZFBCIf@dpg-d7t1rmreo5us73evjp2g-a.oregon-postgres.render.com/breakbuddy_db_zbn3';
const SUPABASE_URL = process.env.SUPABASE_DB_URL || 'postgresql://postgres:dbsbreak%40123@db.himqkriqwaeaohqszxmm.supabase.co:5432/postgres';

const renderPool = new Pool({
    connectionString: RENDER_URL,
    ssl: { rejectUnauthorized: false }
});

const supabasePool = new Pool({
    connectionString: SUPABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function migrate() {
    console.log('🚀 Starting migration: Render → Supabase\n');

    try {
        // ───── STEP 1: Create Tables on Supabase ─────
        console.log('📦 Step 1: Creating tables on Supabase...');

        await supabasePool.query(`
            CREATE TABLE IF NOT EXISTS employees (
                id SERIAL PRIMARY KEY,
                emp_id TEXT UNIQUE,
                name TEXT
            );
        `);

        await supabasePool.query(`
            CREATE SEQUENCE IF NOT EXISTS emp_seq START 1;
        `);

        await supabasePool.query(`
            CREATE TABLE IF NOT EXISTS break_logs (
                id SERIAL PRIMARY KEY,
                emp_id TEXT,
                employee_name TEXT,
                reason TEXT,
                extra_reason TEXT,
                start_time TIMESTAMP,
                end_time TIMESTAMP,
                duration INTEGER,
                ended_by TEXT
            );
        `);

        await supabasePool.query(`
            CREATE TABLE IF NOT EXISTS admin (
                id SERIAL PRIMARY KEY,
                username TEXT UNIQUE,
                password TEXT
            );
        `);

        console.log('✅ Tables created on Supabase\n');

        // ───── STEP 2: Migrate employees ─────
        console.log('👥 Step 2: Migrating employees...');
        const empResult = await renderPool.query('SELECT * FROM employees ORDER BY id');
        const employees = empResult.rows;
        console.log(`   Found ${employees.length} employees in Render`);

        for (const emp of employees) {
            await supabasePool.query(`
                INSERT INTO employees (id, emp_id, name)
                VALUES ($1, $2, $3)
                ON CONFLICT (emp_id) DO UPDATE SET name = EXCLUDED.name
            `, [emp.id, emp.emp_id, emp.name]);
        }

        // Sync sequence
        if (employees.length > 0) {
            const maxId = Math.max(...employees.map(e => e.id));
            await supabasePool.query(`SELECT setval('employees_id_seq', $1)`, [maxId]);
            
            // Sync emp_seq based on highest emp number
            const empNums = employees.map(e => parseInt(e.emp_id.replace('PUN', ''))).filter(n => !isNaN(n));
            if (empNums.length > 0) {
                const maxEmpNum = Math.max(...empNums);
                await supabasePool.query(`SELECT setval('emp_seq', $1)`, [maxEmpNum]);
            }
        }

        console.log(`✅ ${employees.length} employees migrated\n`);

        // ───── STEP 3: Migrate break_logs ─────
        console.log('📋 Step 3: Migrating break logs...');
        const logsResult = await renderPool.query('SELECT * FROM break_logs ORDER BY id');
        const logs = logsResult.rows;
        console.log(`   Found ${logs.length} break log entries in Render`);

        for (const log of logs) {
            await supabasePool.query(`
                INSERT INTO break_logs (id, emp_id, employee_name, reason, extra_reason, start_time, end_time, duration, ended_by)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                ON CONFLICT (id) DO NOTHING
            `, [log.id, log.emp_id, log.employee_name, log.reason, log.extra_reason, log.start_time, log.end_time, log.duration, log.ended_by]);
        }

        // Sync sequence
        if (logs.length > 0) {
            const maxLogId = Math.max(...logs.map(l => l.id));
            await supabasePool.query(`SELECT setval('break_logs_id_seq', $1)`, [maxLogId]);
        }

        console.log(`✅ ${logs.length} break log entries migrated\n`);

        // ───── STEP 4: Migrate admin ─────
        console.log('🔐 Step 4: Migrating admin accounts...');
        const adminResult = await renderPool.query('SELECT * FROM admin');
        const admins = adminResult.rows;
        console.log(`   Found ${admins.length} admin accounts in Render`);

        for (const admin of admins) {
            await supabasePool.query(`
                INSERT INTO admin (id, username, password)
                VALUES ($1,$2,$3)
                ON CONFLICT (username) DO UPDATE SET password = EXCLUDED.password
            `, [admin.id, admin.username, admin.password]);
        }

        if (admins.length > 0) {
            const maxAdminId = Math.max(...admins.map(a => a.id));
            await supabasePool.query(`SELECT setval('admin_id_seq', $1)`, [maxAdminId]);
        }

        console.log(`✅ ${admins.length} admin accounts migrated\n`);

        // ───── STEP 5: Verify ─────
        console.log('🔍 Step 5: Verifying migration...');
        const supEmp = await supabasePool.query('SELECT COUNT(*) FROM employees');
        const supLogs = await supabasePool.query('SELECT COUNT(*) FROM break_logs');
        const supAdmin = await supabasePool.query('SELECT COUNT(*) FROM admin');

        console.log(`   ✅ Supabase employees: ${supEmp.rows[0].count}`);
        console.log(`   ✅ Supabase break_logs: ${supLogs.rows[0].count}`);
        console.log(`   ✅ Supabase admin: ${supAdmin.rows[0].count}`);

        console.log('\n🎉 Migration completed successfully!');

    } catch (err) {
        console.error('\n❌ Migration failed:', err.message);
        process.exit(1);
    } finally {
        await renderPool.end();
        await supabasePool.end();
    }
}

migrate();
