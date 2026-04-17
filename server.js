const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const Razorpay = require('razorpay');
require('dotenv').config();

const db = require('./database');
const app = express();
const PORT = process.env.PORT || 3000;

/* =========================
   🔐 RAZORPAY SETUP
========================= */
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

const hasRazorpayConfig = Boolean(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET);

let razorpay = null;

if (hasRazorpayConfig) {
    razorpay = new Razorpay({
        key_id: RAZORPAY_KEY_ID,
        key_secret: RAZORPAY_KEY_SECRET
    });
} else {
    console.warn("❌ Razorpay keys missing.");
}

/* =========================
   ⚙️ MIDDLEWARE
========================= */
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* =========================
   📅 SLOT CONFIG
========================= */
const MASTER_SLOTS = [
    '01:00 PM', '02:00 PM', '03:00 PM',
    '04:00 PM', '05:00 PM', '06:00 PM', '07:30 PM'
];
const DEFAULT_ADVANCE_BOOKING_DAYS = 14;

function calculatePrice(dateStr) {
    const d = new Date(dateStr);
    const day = d.getDay();
    return (day === 0 || day === 6) ? 300 : 200;
}

function parseYyyyMmDd(dateStr) {
    const parts = String(dateStr || "").split("-");
    if (parts.length !== 3) return null;
    const [year, month, day] = parts.map(Number);
    if (!year || !month || !day) return null;
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed;
}

function getTodayUtcDate() {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function canBookDate(dateStr, advanceDays) {
    const selected = parseYyyyMmDd(dateStr);
    if (!selected) return false;
    const today = getTodayUtcDate();
    const lastAllowed = new Date(today);
    lastAllowed.setUTCDate(today.getUTCDate() + advanceDays);
    return selected >= today && selected <= lastAllowed;
}

function getBookingSettings(callback) {
    db.get(
        "SELECT value FROM settings WHERE key = 'advance_booking_days'",
        [],
        (err, row) => {
            if (err) return callback(err);
            const parsed = Number.parseInt(row?.value, 10);
            const advanceBookingDays = Number.isNaN(parsed) ? DEFAULT_ADVANCE_BOOKING_DAYS : parsed;
            return callback(null, { advance_booking_days: advanceBookingDays });
        }
    );
}

/* =========================
   🌐 PUBLIC APIs
========================= */

// Get slots
app.get('/api/slots', (req, res) => {
    const date = req.query.date;
    if (!date) return res.status(400).json({ error: "Date required" });

    getBookingSettings((settingsErr, settings) => {
        if (settingsErr) return res.status(500).json({ error: settingsErr.message });
        if (!canBookDate(date, settings.advance_booking_days)) {
            return res.status(400).json({ error: `Bookings are allowed only up to ${settings.advance_booking_days} day(s) from today.` });
        }

        const slots = MASTER_SLOTS.map((time, index) => ({
            id: index + 1,
            time,
            is_available: true
        }));

        res.json(slots);
    });
});

// Create Razorpay order
app.post('/api/book/order', async (req, res) => {
    const { date, time, name, phone, children_count } = req.body;
    const parsedChildrenCount = Number.parseInt(children_count, 10);

    if (!date || !time || !name || !phone || Number.isNaN(parsedChildrenCount)) {
        return res.status(400).json({ error: "Missing fields" });
    }
    if (parsedChildrenCount < 1 || parsedChildrenCount > 20) {
        return res.status(400).json({ error: "Children count must be between 1 and 20." });
    }

    getBookingSettings(async (settingsErr, settings) => {
        if (settingsErr) return res.status(500).json({ error: settingsErr.message });
        if (!canBookDate(date, settings.advance_booking_days)) {
            return res.status(400).json({ error: `Bookings are allowed only up to ${settings.advance_booking_days} day(s) from today.` });
        }

        if (!hasRazorpayConfig || !razorpay) {
            return res.status(500).json({ error: "Payment is not configured on server." });
        }

        const pricePerChildINR = calculatePrice(date);
        const amountINR = pricePerChildINR * parsedChildrenCount;

        try {
            const order = await razorpay.orders.create({
                amount: amountINR * 100,
                currency: "INR",
                receipt: `rcpt_${Date.now()}`
            });

            // Remove old pending booking
            db.run(
                "DELETE FROM bookings WHERE date = ? AND time = ? AND status = 'PENDING'",
                [date, time],
                (err) => {
                    if (err) return res.status(500).json({ error: err.message });

                    db.run(
                        "INSERT INTO bookings (date, time, name, phone, children_count, amount, order_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING')",
                        [date, time, name, phone, parsedChildrenCount, amountINR, order.id],
                        function (err) {
                            if (err) return res.status(500).json({ error: err.message });

                            res.json({
                                order_id: order.id,
                                amount: amountINR,
                                price_per_child: pricePerChildINR,
                                key_id: RAZORPAY_KEY_ID,
                                name,
                                phone,
                                children_count: parsedChildrenCount
                            });
                        }
                    );
                }
            );

        } catch (err) {
            console.error("Order creation error:", err);
            res.status(500).json({ error: "Failed to create order" });
        }
    });
});

// Verify payment
app.post('/api/book/verify', (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!hasRazorpayConfig || !razorpay) {
        return res.status(500).json({ error: "Payment is not configured on server." });
    }

    try {
        const hmac = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET);
        hmac.update(`${razorpay_order_id}|${razorpay_payment_id}`);

        const expectedSignature = hmac.digest('hex');

        if (expectedSignature === razorpay_signature) {
            db.run(
                "UPDATE bookings SET status='CONFIRMED', payment_id=? WHERE order_id=?",
                [razorpay_payment_id, razorpay_order_id],
                function (err) {
                    if (err) return res.status(500).json({ error: err.message });

                    return res.json({ success: true });
                }
            );
        } else {
            return res.status(400).json({ error: "Invalid signature" });
        }

    } catch (err) {
        console.error("Verification error:", err);
        return res.status(500).json({ error: "Verification failed" });
    }
});

// Price API
app.get('/api/price', (req, res) => {
    const date = req.query.date;
    if (!date) return res.json({ price: 0 });
    res.json({ price: calculatePrice(date) });
});

// Booking settings (public, read-only)
app.get('/api/settings', (req, res) => {
    getBookingSettings((err, settings) => {
        if (err) return res.status(500).json({ error: err.message });
        return res.json(settings);
    });
});

/* =========================
   🔧 ADMIN APIs
========================= */

// Get bookings
app.get('/api/admin/bookings', (req, res) => {
    const date = req.query.date;
    const all = req.query.all === '1';

    let query = "SELECT * FROM bookings ORDER BY date DESC";
    let params = [];

    if (!all && date) {
        query = "SELECT * FROM bookings WHERE date=?";
        params = [date];
    }

    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Export bookings CSV
app.get('/api/admin/bookings/export', (req, res) => {
    const date = req.query.date;
    const all = req.query.all === '1';

    let query = "SELECT date, time, name, phone, children_count, amount, status, order_id, payment_id, created_at FROM bookings ORDER BY date DESC, time ASC";
    let params = [];

    if (!all && date) {
        query = "SELECT date, time, name, phone, children_count, amount, status, order_id, payment_id, created_at FROM bookings WHERE date=? ORDER BY time ASC";
        params = [date];
    }

    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        const escapeCsv = (value) => {
            if (value === null || value === undefined) return "";
            const str = String(value);
            if (str.includes('"') || str.includes(",") || str.includes("\n")) {
                return `"${str.replace(/"/g, '""')}"`;
            }
            return str;
        };

        const headers = ["date", "time", "name", "phone", "children_count", "amount", "status", "order_id", "payment_id", "created_at"];
        const lines = [
            headers.join(","),
            ...rows.map((row) => headers.map((key) => escapeCsv(row[key])).join(","))
        ];
        const csvContent = lines.join("\n");
        const safeDate = all ? "all" : (date || "all");

        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="bookings-${safeDate}.csv"`);
        return res.status(200).send(csvContent);
    });
});

// Read booking window setting
app.get('/api/admin/settings', (req, res) => {
    getBookingSettings((err, settings) => {
        if (err) return res.status(500).json({ error: err.message });
        return res.json(settings);
    });
});

// Update booking window setting
app.put('/api/admin/settings', (req, res) => {
    const parsedDays = Number.parseInt(req.body?.advance_booking_days, 10);
    if (Number.isNaN(parsedDays) || parsedDays < 1 || parsedDays > 60) {
        return res.status(400).json({ error: "advance_booking_days must be between 1 and 60." });
    }

    db.run(
        "INSERT INTO settings (key, value) VALUES ('advance_booking_days', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [String(parsedDays)],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            return res.json({ success: true, advance_booking_days: parsedDays });
        }
    );
});

// Reset day
app.post('/api/admin/reset', (req, res) => {
    const { date } = req.body;

    if (!date) return res.status(400).json({ error: "Date required" });

    db.run("DELETE FROM bookings WHERE date=?", [date], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Reset successful" });
    });
});

// Toggle slot
app.put('/api/admin/slots/toggle', (req, res) => {
    const { date, time, is_available } = req.body;

    if (!date || !time || is_available === undefined) {
        return res.status(400).json({ error: "Missing fields" });
    }

    if (is_available) {
        db.run("DELETE FROM bookings WHERE date=? AND time=?", [date, time], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: "Slot available" });
        });
    } else {
        db.run(
            "INSERT INTO bookings (date, time, name, status) VALUES (?, ?, 'Admin Blocked', 'BLOCKED')",
            [date, time],
            (err) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ message: "Slot blocked" });
            }
        );
    }
});

/* =========================
   🚀 START SERVER
========================= */
app.listen(PORT, () => {
    console.log(`🚀 Server running on PORT ${PORT}`);
});
