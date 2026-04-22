const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const db = new sqlite3.Database('./database.db');

// IST time
function getISTISOString() {
    return new Date().toLocaleString("sv-SE", {
        timeZone: "Asia/Kolkata"
    }).replace(" ", "T");
}

// ================= DB SETUP =================
db.serialize(() => {
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA busy_timeout = 5000");

    db.run(`CREATE TABLE IF NOT EXISTS employees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        emp_id TEXT UNIQUE,
        name TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS break_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        emp_id TEXT,
        employee_name TEXT,
        reason TEXT,
        extra_reason TEXT,
        start_time TEXT,
        end_time TEXT,
        duration INTEGER
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS admin (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT
    )`);

    db.run(`INSERT OR IGNORE INTO admin (id, username, password)
        VALUES (1, 'admin', 'admin123')`);
});

// ================= ADMIN AUTH =================

app.post('/admin-login', (req, res) => {
    const { username, password } = req.body;

    db.get(
        "SELECT * FROM admin WHERE username=? AND password=?",
        [username, password],
        (e, row) => {
            if (!row) return res.json({ error: "Invalid credentials" });

            const token = Buffer.from(username + Date.now()).toString('base64');
            res.json({ token });
        }
    );
});

function verifyAdmin(req, res, next) {
    const token = req.headers['authorization'];

    if (!token) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    try {
        Buffer.from(token, 'base64').toString('ascii');
        next();
    } catch {
        res.status(401).json({ error: "Invalid token" });
    }
}

// ================= EMPLOYEE =================

app.get('/employees', verifyAdmin, (req, res) => {
    db.all("SELECT * FROM employees", [], (e, r) => res.json(r));
});

app.post('/add-employee', verifyAdmin, (req, res) => {
    const { name } = req.body;

    db.get("SELECT COUNT(*) as count FROM employees", [], (e, row) => {
        const id = "EMP" + String(row.count + 1).padStart(3, '0');

        db.run(
            "INSERT INTO employees (emp_id,name) VALUES (?,?)",
            [id, name],
            () => res.json({ emp_id: id })
        );
    });
});

app.delete('/delete-employee/:emp_id', verifyAdmin, (req, res) => {
    db.run(
        "DELETE FROM employees WHERE emp_id=?",
        [req.params.emp_id],
        () => res.json({ success: true })
    );
});

// ================= USER FLOW =================

app.post('/validate', (req, res) => {
    const { emp_id } = req.body;

    db.get("SELECT * FROM employees WHERE emp_id=?", [emp_id], (e, row) => {
        if (row) res.json({ valid: true, name: row.name });
        else res.json({ valid: false });
    });
});

app.post('/status', (req, res) => {
    const { emp_id } = req.body;

    db.get(
        "SELECT * FROM break_logs WHERE emp_id=? AND end_time IS NULL",
        [emp_id],
        (e, row) => {
            if (row) res.json({ active: true, ...row });
            else res.json({ active: false });
        }
    );
});

app.post('/start', (req, res) => {
    const { emp_id, reason, extra } = req.body;

    if (!emp_id || !reason) {
        return res.json({ error: "Missing data" });
    }

    db.get(
        "SELECT * FROM break_logs WHERE emp_id=? AND end_time IS NULL",
        [emp_id],
        (e, row) => {
            if (row) return res.json({ error: "Break already active" });

            const start = getISTISOString();

            db.get(
                "SELECT name FROM employees WHERE emp_id=?",
                [emp_id],
                (e, emp) => {
                    db.run(
                        `INSERT INTO break_logs 
                        (emp_id,employee_name,reason,extra_reason,start_time)
                        VALUES (?,?,?,?,?)`,
                        [emp_id, emp.name, reason, extra, start],
                        () => res.json({ start_time: start })
                    );
                }
            );
        }
    );
});

app.post('/stop', (req, res) => {
    const { emp_id } = req.body;

    db.get(
        "SELECT * FROM break_logs WHERE emp_id=? AND end_time IS NULL",
        [emp_id],
        (e, row) => {
            if (!row) return res.json({ error: "No active break" });

            const end = getISTISOString();

            const duration = Math.floor(
                (new Date(end) - new Date(row.start_time)) / 1000
            );

            db.run(
                "UPDATE break_logs SET end_time=?, duration=? WHERE id=?",
                [end, duration, row.id],
                () => res.json({ success: true })
            );
        }
    );
});

// ================= ADMIN =================

app.get('/active-breaks', verifyAdmin, (req, res) => {
    db.all(
        "SELECT * FROM break_logs WHERE end_time IS NULL",
        [],
        (e, r) => res.json(r)
    );
});

app.get('/logs', verifyAdmin, (req, res) => {
    db.all(
        "SELECT * FROM break_logs ORDER BY id DESC",
        [],
        (e, r) => res.json(r)
    );
});

app.post('/filter-logs', verifyAdmin, (req, res) => {
    const { emp_id, from, to } = req.body;

    let query = "SELECT * FROM break_logs WHERE 1=1";
    let params = [];

    if (emp_id) {
        query += " AND emp_id=?";
        params.push(emp_id);
    }

    if (from && to) {
        query += " AND date(start_time) BETWEEN date(?) AND date(?)";
        params.push(from, to);
    }

    db.all(query, params, (e, r) => res.json(r));
});

app.post('/force-stop', verifyAdmin, (req, res) => {
    const { emp_id } = req.body;

    db.get(
        "SELECT * FROM break_logs WHERE emp_id=? AND end_time IS NULL",
        [emp_id],
        (e, row) => {
            if (!row) return res.json({ error: "No active break" });

            const end = getISTISOString();

            const duration = Math.floor(
                (new Date(end) - new Date(row.start_time)) / 1000
            );

            db.run(
                "UPDATE break_logs SET end_time=?, duration=? WHERE id=?",
                [end, duration, row.id],
                () => res.json({ success: true })
            );
        }
    );
});

app.get('/summary', verifyAdmin, (req, res) => {
    db.all(`
        SELECT employee_name, SUM(duration) as total_seconds
        FROM break_logs
        WHERE duration IS NOT NULL
        GROUP BY employee_name
    `, [], (e, r) => res.json(r));
});

// ✅ FIXED EXPORT (MAIN ERROR FIX)
app.get('/export', verifyAdmin, (req, res) => {

    function format(sec){
        if(!sec) return "0:00:00";
        let h = Math.floor(sec / 3600);
        let m = Math.floor((sec % 3600) / 60);
        let s = sec % 60;
        return `${h}:${m}:${s}`;
    }

    db.all("SELECT * FROM break_logs", [], (e, rows) => {

        let csv = "Name,Reason,Start,End,Duration\n";

        rows.forEach(r => {
            csv += `${r.employee_name},${r.reason},${r.start_time},${r.end_time || ""},${format(r.duration)}\n`;
        });

        res.header("Content-Type", "text/csv");
        res.attachment("logs.csv");
        res.send(csv);
    });
});

// ================= START =================
const PORT = 3000;
app.listen(PORT, () => console.log("🚀 Server running on port", PORT));