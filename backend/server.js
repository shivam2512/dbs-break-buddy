const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();

const SECRET = "MY_SUPER_SECRET_KEY_123";

app.use(express.json());
app.use(cors());

// ================= DB CONNECTION =================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ================= INIT DB =================
async function initDB() {

    await pool.query(`
        CREATE TABLE IF NOT EXISTS employees (
            id SERIAL PRIMARY KEY,
            emp_id TEXT UNIQUE,
            name TEXT
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS break_logs (
            id SERIAL PRIMARY KEY,
            emp_id TEXT,
            employee_name TEXT,
            reason TEXT,
            extra_reason TEXT,
            start_time TIMESTAMP,
            end_time TIMESTAMP,
            duration INTEGER
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS admin (
            id SERIAL PRIMARY KEY,
            username TEXT UNIQUE,
            password TEXT
        );
    `);

    const hashed = bcrypt.hashSync("admin123", 10);

    await pool.query(`
        INSERT INTO admin (username, password)
        VALUES ('admin', $1)
        ON CONFLICT (username) DO NOTHING
    `, [hashed]);
}

initDB();

// ================= AUTH =================
app.post('/admin-login', async (req, res) => {
    const { username, password } = req.body;

    const result = await pool.query(
        "SELECT * FROM admin WHERE username=$1",
        [username]
    );

    const user = result.rows[0];

    if (!user) return res.json({ error: "Invalid credentials" });

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) return res.json({ error: "Invalid credentials" });

    const token = jwt.sign({ username: user.username }, SECRET, { expiresIn: "1h" });

    res.json({ token });
});

function verifyAdmin(req, res, next) {
    const token = req.headers['authorization'];

    if (!token) return res.status(401).json({ error: "Unauthorized" });

    try {
        req.user = jwt.verify(token, SECRET);
        next();
    } catch {
        return res.status(401).json({ error: "Session expired" });
    }
}

// ================= EMPLOYEE =================
app.get('/employees', verifyAdmin, async (req, res) => {
    const r = await pool.query("SELECT * FROM employees");
    res.json(r.rows);
});

app.post('/add-employee', verifyAdmin, async (req, res) => {
    const { name } = req.body;

    const countRes = await pool.query("SELECT COUNT(*) FROM employees");
    const id = "EMP" + String(Number(countRes.rows[0].count) + 1).padStart(3, '0');

    await pool.query(
        "INSERT INTO employees (emp_id,name) VALUES ($1,$2)",
        [id, name]
    );

    res.json({ emp_id: id });
});

app.delete('/delete-employee/:emp_id', verifyAdmin, async (req, res) => {
    await pool.query("DELETE FROM employees WHERE emp_id=$1", [req.params.emp_id]);
    res.json({ success: true });
});

// ================= USER =================
app.post('/validate', async (req, res) => {
    const { emp_id } = req.body;

    const r = await pool.query(
        "SELECT * FROM employees WHERE emp_id=$1",
        [emp_id]
    );

    if (r.rows.length) res.json({ valid: true, name: r.rows[0].name });
    else res.json({ valid: false });
});

app.post('/status', async (req, res) => {
    const { emp_id } = req.body;

    const r = await pool.query(
        "SELECT * FROM break_logs WHERE emp_id=$1 AND end_time IS NULL",
        [emp_id]
    );

    if (r.rows.length) res.json({ active: true, ...r.rows[0] });
    else res.json({ active: false });
});

app.post('/start', async (req, res) => {
    const { emp_id, reason, extra } = req.body;

    const active = await pool.query(
        "SELECT * FROM break_logs WHERE emp_id=$1 AND end_time IS NULL",
        [emp_id]
    );

    if (active.rows.length) return res.json({ error: "Break already active" });

    const emp = await pool.query(
        "SELECT name FROM employees WHERE emp_id=$1",
        [emp_id]
    );

    const start = new Date();

    await pool.query(`
        INSERT INTO break_logs 
        (emp_id, employee_name, reason, extra_reason, start_time)
        VALUES ($1,$2,$3,$4,$5)
    `, [emp_id, emp.rows[0].name, reason, extra, start]);

    res.json({ start_time: start });
});

app.post('/stop', async (req, res) => {
    const { emp_id } = req.body;

    const r = await pool.query(
        "SELECT * FROM break_logs WHERE emp_id=$1 AND end_time IS NULL",
        [emp_id]
    );

    if (!r.rows.length) return res.json({ error: "No active break" });

    const row = r.rows[0];
    const end = new Date();

    const duration = Math.floor((end - new Date(row.start_time)) / 1000);

    await pool.query(
        "UPDATE break_logs SET end_time=$1, duration=$2 WHERE id=$3",
        [end, duration, row.id]
    );

    res.json({ success: true });
});

// ================= ADMIN =================
app.get('/active-breaks', verifyAdmin, async (req, res) => {
    const r = await pool.query(
        "SELECT * FROM break_logs WHERE end_time IS NULL"
    );
    res.json(r.rows);
});

app.get('/logs', verifyAdmin, async (req, res) => {
    const r = await pool.query(
        "SELECT * FROM break_logs ORDER BY id DESC"
    );
    res.json(r.rows);
});

app.post('/filter-logs', verifyAdmin, async (req, res) => {
    const { emp_id, from, to } = req.body;

    let query = "SELECT * FROM break_logs WHERE 1=1";
    let params = [];

    if (emp_id) {
        params.push(emp_id);
        query += ` AND emp_id=$${params.length}`;
    }

    if (from && to) {
        params.push(from, to);
        query += ` AND DATE(start_time) BETWEEN $${params.length-1} AND $${params.length}`;
    }

    const r = await pool.query(query, params);
    res.json(r.rows);
});

app.post('/force-stop', verifyAdmin, async (req, res) => {
    const { emp_id } = req.body;

    const r = await pool.query(
        "SELECT * FROM break_logs WHERE emp_id=$1 AND end_time IS NULL",
        [emp_id]
    );

    if (!r.rows.length) return res.json({ error: "No active break" });

    const row = r.rows[0];
    const end = new Date();

    const duration = Math.floor((end - new Date(row.start_time)) / 1000);

    await pool.query(
        "UPDATE break_logs SET end_time=$1, duration=$2 WHERE id=$3",
        [end, duration, row.id]
    );

    res.json({ success: true });
});

// ================= EXPORT =================
app.get('/export', verifyAdmin, async (req, res) => {

    function format(sec){
        if(!sec) return "0:00:00";
        let h = Math.floor(sec / 3600);
        let m = Math.floor((sec % 3600) / 60);
        let s = sec % 60;
        return `${h}:${m}:${s}`;
    }

    const r = await pool.query("SELECT * FROM break_logs");

    let csv = "Name,Reason,Extra Details,Start,End,Duration\n";

    r.rows.forEach(row => {
        csv += `${row.employee_name},${row.reason},${row.extra_reason || ""},${row.start_time},${row.end_time || ""},${format(row.duration)}\n`;
    });

    res.header("Content-Type", "text/csv");
    res.attachment("logs.csv");
    res.send(csv);
});

// ================= START =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Server running on port", PORT));