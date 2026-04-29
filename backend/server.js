const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const cron = require('node-cron');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
const SECRET = "MY_SUPER_SECRET_KEY_123";

app.use(express.json());
app.use(cors());

// ================= DB CONNECTION =================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ================= EMAIL CONFIG =================
const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.EMAIL_USER,   // set in Render ENV
        pass: process.env.EMAIL_PASS    // Gmail App Password
    }
});

// ================= BACKUP FOLDER =================
const backupDir = path.join(__dirname, "backups");

if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir);
}

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

// ================= START =================
app.post('/start', async (req, res) => {
    const { emp_id, reason, extra } = req.body;

    const emp = await pool.query(
        "SELECT name FROM employees WHERE emp_id=$1",
        [emp_id]
    );

    const start = new Date();

    await pool.query(`
        INSERT INTO break_logs 
        (emp_id, employee_name, reason, extra_reason, start_time)
        VALUES ($1,$2,$3,$4,$5)
    `, [
        emp_id,
        emp.rows[0].name,
        reason,
        extra || null,
        start
    ]);

    res.json({ start_time: start });
});

// ================= STOP =================
app.post('/stop', async (req, res) => {
    const { emp_id } = req.body;

    const r = await pool.query(
        "SELECT * FROM break_logs WHERE emp_id=$1 AND end_time IS NULL",
        [emp_id]
    );

    const row = r.rows[0];
    const end = new Date();

    const duration = Math.floor((end - new Date(row.start_time)) / 1000);

    await pool.query(
        "UPDATE break_logs SET end_time=$1, duration=$2, ended_by='USER' WHERE id=$3",
        [end, duration, row.id]
    );

    res.json({ success: true });
});

// ================= DAILY BACKUP + EMAIL =================

// ⏰ 1:26 AM IST = 7:56 PM UTC
cron.schedule('14 20 * * *', () => {

    const date = new Date().toISOString().split("T")[0];
    const filePath = path.join(backupDir, `backup_${date}.sql`);

    console.log("📦 Backup started...");

    const command = `pg_dump "${process.env.DATABASE_URL}" -f "${filePath}"`;

    exec(command, async (err) => {

        if (err) {
            console.error("❌ Backup failed:", err);
            return;
        }

        console.log("✅ Backup created:", filePath);

        try {
            await transporter.sendMail({
                from: process.env.EMAIL_USER,
                to: process.env.EMAIL_TO,   // receiver email
                subject: `DB Backup - ${date}`,
                text: "Daily DB backup attached",
                attachments: [
                    {
                        filename: `backup_${date}.sql`,
                        path: filePath
                    }
                ]
            });

            console.log("📧 Email sent");

        } catch (e) {
            console.error("❌ Email failed:", e);
        }

        // delete file after sending
        try {
            fs.unlinkSync(filePath);
            console.log("🗑 Backup deleted");
        } catch (e) {
            console.error("Delete failed:", e);
        }

    });

});

// ================= START =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Server running on port", PORT));