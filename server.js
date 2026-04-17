require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// Razorpay config (fail clearly if missing in deployment)
const RAZORPAY_KEY_ID = (process.env.RAZORPAY_KEY_ID || '').trim();
const RAZORPAY_KEY_SECRET = (process.env.RAZORPAY_KEY_SECRET || '').trim();
const hasRazorpayConfig = Boolean(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET);

if (!hasRazorpayConfig) {
    console.warn("Razorpay keys are missing. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.");
}

const razorpay = hasRazorpayConfig
    ? new Razorpay({
        key_id: RAZORPAY_KEY_ID,
        key_secret: RAZORPAY_KEY_SECRET
    })
    : null;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Fixed Master Slots
const MASTER_SLOTS = [
    '01:00 PM', '02:00 PM', '03:00 PM', '04:00 PM', 
    '05:00 PM', '06:00 PM', '07:30 PM'
];

// Helper: Calculate price based on date string (YYYY-MM-DD)
function calculatePrice(dateStr) {
    const d = new Date(dateStr);
    const day = d.getDay(); // 0 = Sun, 6 = Sat
    if (day === 0 || day === 6) return 300; // Weekend
    return 200; // Weekday
}

// --- API ROUTES ---

// 1. Get all slots for a specific date
app.get('/api/slots', (req, res) => {
    const date = req.query.date; // format: YYYY-MM-DD
    if (!date) return res.status(400).json({ error: "Date is required." });

    const slots = MASTER_SLOTS.map((time, index) => ({
        id: index + 1,
        time: time,
        is_available: true
    }));

    res.json(slots);
});

// 2. Create Razorpay Order & Pending Booking
app.post('/api/book/order', async (req, res) => {
    const { date, time, name, phone } = req.body;
    if (!date || !time || !name || !phone) return res.status(400).json({ error: "Missing required fields." });
    if (!hasRazorpayConfig || !razorpay) return res.status(500).json({ error: "Payment is not configured on server." });

    const amountINR = calculatePrice(date);
    
    try {
        const order = await razorpay.orders.create({
            amount: amountINR * 100, // exact paise
            currency: "INR",
            receipt: `rcpt_${Date.now()}`
        });

        // Keep only one active PENDING row per slot to avoid unique constraint conflicts.
        db.run("DELETE FROM bookings WHERE date = ? AND time = ? AND status = 'PENDING'", [date, time], (err) => {
            if (err) return res.status(500).json({ error: err.message });

            db.run(
                "INSERT INTO bookings (date, time, name, phone, amount, order_id, status) VALUES (?, ?, ?, ?, ?, ?, 'PENDING')", 
                [date, time, name, phone, amountINR, order.id], 
                function(err) {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({
                        order_id: order.id,
                        amount: amountINR,
                        key_id: RAZORPAY_KEY_ID,
                        name, phone
                    });
                }
            );
        });
    } catch (error) {
        console.error("Razorpay Error:", error);
        res.status(500).json({ error: "Failed to create payment order." });
    }
});

// 3. Verify Razorpay Payment
app.post('/api/book/verify', (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!hasRazorpayConfig || !razorpay) return res.status(500).json({ error: "Payment is not configured on server." });

    // Verify signature
    const hmac = crypto.createHmac('sha256', razorpay.key_secret);
    hmac.update(razorpay_order_id + "|" + razorpay_payment_id);
    const expectedSignature = hmac.digest('hex');

    if (expectedSignature === razorpay_signature) {
        // Payment successful - Mark Confirmed
        db.run(
            "UPDATE bookings SET status = 'CONFIRMED', payment_id = ? WHERE order_id = ?",
            [razorpay_payment_id, razorpay_order_id],
            function(err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true });
            }
        );
    } else {
        res.status(400).json({ error: "Invalid payment signature." });
    }
});

// Calculate Pricing Info helper endpoint (frontend UI usage)
app.get('/api/price', (req, res) => {
    const date = req.query.date;
    if (!date) return res.json({ price: 0 });
    res.json({ price: calculatePrice(date) });
});


// --- ADMIN API ROUTES ---

function toCsvValue(value) {
    if (value === null || value === undefined) return '';
    const stringValue = String(value);
    return `"${stringValue.replace(/"/g, '""')}"`;
}

// Get all bookings
app.get('/api/admin/bookings', (req, res) => {
    const date = req.query.date; // optional
    let query = "SELECT id, name, phone, date, time, amount, status FROM bookings WHERE status IN ('CONFIRMED', 'BLOCKED') ORDER BY date DESC, time ASC LIMIT 100";
    let params = [];
    
    if (date) {
        query = "SELECT id, name, phone, date, time, amount, status FROM bookings WHERE date = ? AND status IN ('CONFIRMED', 'BLOCKED') ORDER BY time ASC";
        params = [date];
    }
    
    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Export bookings as CSV
app.get('/api/admin/bookings/export', (req, res) => {
    const date = req.query.date; // optional YYYY-MM-DD
    let query = "SELECT id, date, time, name, phone, amount, status, order_id, payment_id, created_at FROM bookings ORDER BY date DESC, time ASC";
    let params = [];

    if (date) {
        query = "SELECT id, date, time, name, phone, amount, status, order_id, payment_id, created_at FROM bookings WHERE date = ? ORDER BY time ASC";
        params = [date];
    }

    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        const header = ['Booking ID', 'Date', 'Time', 'Name', 'Phone', 'Amount', 'Status', 'Order ID', 'Payment ID', 'Created At'];
        const csvLines = [header.map(toCsvValue).join(',')];

        rows.forEach((row) => {
            csvLines.push([
                row.id,
                row.date,
                row.time,
                row.name,
                row.phone,
                row.amount,
                row.status,
                row.order_id,
                row.payment_id,
                row.created_at
            ].map(toCsvValue).join(','));
        });

        const csv = csvLines.join('\n');
        const fileName = date ? `bookings-${date}.csv` : 'bookings-all.csv';
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.send(csv);
    });
});

// Reset Day 
app.post('/api/admin/reset', (req, res) => {
    const { date } = req.body;
    if (!date) return res.status(400).json({ error: "Date is required." });

    db.run("DELETE FROM bookings WHERE date = ?", [date], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Day reset successfully." });
    });
});

// Toggle slot availability manually
app.put('/api/admin/slots/toggle', (req, res) => {
    const { date, time, is_available } = req.body;
    if (!date || !time || is_available === undefined) return res.status(400).json({ error: "Missing fields" });

    if (is_available) { // user wants to make it available (delete the BLOCKED or CONFIRMED booking)
        db.run("DELETE FROM bookings WHERE date = ? AND time = ?", [date, time], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: "Slot is now available." });
        });
    } else { // user wants to make it unavailable (insert BLOCKED)
        db.run("INSERT INTO bookings (date, time, name, status) VALUES (?, ?, 'Admin Blocked', 'BLOCKED')", [date, time], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: "Slot is now blocked." });
        });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running gracefully on http://localhost:${PORT}`);
});
