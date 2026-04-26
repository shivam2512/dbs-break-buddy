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

// ================= TIME FORMAT =================
function toIST(date) {
    if (!date) return "";
    return new Date(date).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        hour12: true
    });
}

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
        CREATE SEQUENCE IF NOT EXISTS emp_seq START 1;
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
            duration INTEGER,
            ended_by TEXT
        );
    `);

    // ✅ Ensure column exists (important for old DB)
    await pool.query(`
        ALTER TABLE break_logs 
        ADD COLUMN IF NOT EXISTS ended_by TEXT;
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

    const token = jwt.sign(
        { username: user.username },
        SECRET,
        { expiresIn: "20m" }
    );

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

    try {
        const result = await pool.query(`
            INSERT INTO employees (emp_id, name)
            VALUES (
                'PUN' || LPAD(nextval('emp_seq')::text, 4, '0'),
                $1
            )
            RETURNING emp_id
        `, [name]);

        res.json({ emp_id: result.rows[0].emp_id });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to add employee" });
    }
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

// ✅ STATUS FIXED
app.post('/status', async (req, res) => {
    const { emp_id } = req.body;

    const active = await pool.query(
        "SELECT * FROM break_logs WHERE emp_id=$1 AND end_time IS NULL",
        [emp_id]
    );

    if (active.rows.length) {
        return res.json({ active: true, ...active.rows[0] });
    }

    const last = await pool.query(
        "SELECT ended_by FROM break_logs WHERE emp_id=$1 ORDER BY id DESC LIMIT 1",
        [emp_id]
    );

    res.json({
        active: false,
        ended_by: last.rows.length ? last.rows[0].ended_by : null
    });
});

// ================= START =================
app.post('/start', async (req, res) => {
    const { emp_id, reason, extra } = req.body;

    if (!reason || reason.trim() === "") {
        return res.status(400).json({ error: "Please select a reason" });
    }

    const requiresExtra = ["Personal Work", "Meeting", "Feedback", "Quality Feedback", "Operation Feedback", "Other"];

    if (requiresExtra.includes(reason) && (!extra || extra.trim() === "")) {
        return res.status(400).json({ error: "Please enter reason details" });
    }

    const active = await pool.query(
        "SELECT * FROM break_logs WHERE emp_id=$1 AND end_time IS NULL",
        [emp_id]
    );

    if (active.rows.length) {
        return res.json({ error: "Break already active" });
    }

    const emp = await pool.query(
        "SELECT name FROM employees WHERE emp_id=$1",
        [emp_id]
    );

    if (!emp.rows.length) {
        return res.status(404).json({ error: "Employee not found" });
    }

    const start = new Date();

    await pool.query(`
        INSERT INTO break_logs 
        (emp_id, employee_name, reason, extra_reason, start_time)
        VALUES ($1,$2,$3,$4,$5)
    `, [
        emp_id,
        emp.rows[0].name,
        reason.trim(),
        extra ? extra.trim() : null,
        start
    ]);

    res.json({ start_time: start });
});

// ================= STOP (USER) =================
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
        "UPDATE break_logs SET end_time=$1, duration=$2, ended_by='USER' WHERE id=$3",
        [end, duration, row.id]
    );

    res.json({ success: true });
});

// ================= ADMIN =================
app.get('/active-breaks', verifyAdmin, async (req, res) => {
    const r = await pool.query("SELECT * FROM break_logs WHERE end_time IS NULL");
    res.json(r.rows);
});

app.get('/logs', verifyAdmin, async (req, res) => {
    const r = await pool.query("SELECT * FROM break_logs ORDER BY id DESC");

    const formatted = r.rows.map(row => ({
        ...row,
        start_time: toIST(row.start_time),
        end_time: toIST(row.end_time)
    }));

    res.json(formatted);
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

    const formatted = r.rows.map(row => ({
        ...row,
        start_time: toIST(row.start_time),
        end_time: toIST(row.end_time)
    }));

    res.json(formatted);
});

// ================= FORCE STOP (ADMIN) =================
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
        "UPDATE break_logs SET end_time=$1, duration=$2, ended_by='ADMIN' WHERE id=$3",
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

    let csv = "Emp ID,Name,Reason,Extra Details,Start,End,Duration,Ended By\n";

    r.rows.forEach(row => {
        csv += `${row.emp_id},${row.employee_name},${row.reason},${row.extra_reason || ""},"${toIST(row.start_time)}","${toIST(row.end_time)}",${format(row.duration)},${row.ended_by || ""}\n`;
    });

    res.header("Content-Type", "text/csv");
    res.attachment("logs.csv");
    res.send(csv);
});

// ================= START =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Server running on port", PORT));