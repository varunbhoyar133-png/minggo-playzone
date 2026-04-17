const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = process.env.DB_PATH
    ? path.resolve(process.env.DB_PATH)
    : path.resolve(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database ', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        
        db.run(`CREATE TABLE IF NOT EXISTS bookings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT,
            time TEXT,
            name TEXT,
            phone TEXT,
            children_count INTEGER DEFAULT 1,
            amount INTEGER,
            order_id TEXT,
            payment_id TEXT,
            status TEXT DEFAULT 'PENDING',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(date, time)
        )`, (err) => {
            if (err) console.error("Error creating bookings table", err);
        });

        db.run(
            "ALTER TABLE bookings ADD COLUMN children_count INTEGER DEFAULT 1",
            (alterErr) => {
                if (alterErr && !alterErr.message.includes("duplicate column name")) {
                    console.error("Error adding children_count column", alterErr);
                }
            }
        );
    }
});

module.exports = db;
