const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const { Booking, Setting } = require('./database');
const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'replace-this-in-production';
const ADMIN_COOKIE_NAME = 'minggo_admin_token';
const ADMIN_TOKEN_TTL = '12h';
const PENDING_HOLD_MINUTES = 15;

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
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const bookingLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many booking attempts. Please try again in 10 minutes.' }
});

const adminAuthLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts. Please try again in 10 minutes.' }
});

const adminApiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many admin requests. Please slow down.' }
});

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

async function getBookingSettings() {
    const setting = await Setting.findOne({ key: 'advance_booking_days' });
    const parsed = Number.parseInt(setting?.value, 10);
    const advanceBookingDays = Number.isNaN(parsed) ? DEFAULT_ADVANCE_BOOKING_DAYS : parsed;
    return { advance_booking_days: advanceBookingDays };
}

async function cleanupExpiredPendingBookings(date, time) {
    const cutoff = new Date(Date.now() - PENDING_HOLD_MINUTES * 60 * 1000);
    const query = {
        status: 'PENDING',
        created_at: { $lt: cutoff }
    };
    if (date) query.date = date;
    if (time) query.time = time;

    await Booking.deleteMany(query);
}

function verifyAdminPassword(rawPassword, callback) {
    const password = String(rawPassword || '');
    const envPlainPassword = process.env.ADMIN_PASSWORD;
    const envPasswordHash = process.env.ADMIN_PASSWORD_HASH;

    if (envPasswordHash) {
        bcrypt.compare(password, envPasswordHash, callback);
        return;
    }

    if (!envPlainPassword) {
        callback(null, false);
        return;
    }

    const provided = Buffer.from(password);
    const expected = Buffer.from(envPlainPassword);
    if (provided.length !== expected.length) {
        callback(null, false);
        return;
    }
    callback(null, crypto.timingSafeEqual(provided, expected));
}

function requireAdmin(req, res, next) {
    const token = req.cookies?.[ADMIN_COOKIE_NAME];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    try {
        const payload = jwt.verify(token, ADMIN_JWT_SECRET);
        if (payload?.role !== 'admin') return res.status(401).json({ error: 'Unauthorized' });
        req.admin = payload;
        return next();
    } catch (e) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
}

/* =========================
   🌐 PUBLIC APIs
========================= */

// Get slots
app.get('/api/slots', async (req, res) => {
    try {
        const date = req.query.date;
        if (!date) return res.status(400).json({ error: "Date required" });

        const settings = await getBookingSettings();
        if (!canBookDate(date, settings.advance_booking_days)) {
            return res.status(400).json({ error: `Bookings are allowed only up to ${settings.advance_booking_days} day(s) from today.` });
        }

        await cleanupExpiredPendingBookings(date, null);

        const bookings = await Booking.find({
            date: date,
            status: 'BLOCKED'
        });

        const unavailableTimes = new Set(bookings.map((b) => b.time));
        const slots = MASTER_SLOTS.map((time, index) => ({
            id: index + 1,
            time,
            is_available: !unavailableTimes.has(time)
        }));
        res.json(slots);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Create Razorpay order
app.post('/api/book/order', bookingLimiter, async (req, res) => {
    try {
        const { date, time, name, phone, children_count } = req.body;
        const parsedChildrenCount = Number.parseInt(children_count, 10);

        if (!date || !time || !name || !phone || Number.isNaN(parsedChildrenCount)) {
            return res.status(400).json({ error: "Missing fields" });
        }
        if (parsedChildrenCount < 1 || parsedChildrenCount > 20) {
            return res.status(400).json({ error: "Children count must be between 1 and 20." });
        }

        const settings = await getBookingSettings();
        if (!canBookDate(date, settings.advance_booking_days)) {
            return res.status(400).json({ error: `Bookings are allowed only up to ${settings.advance_booking_days} day(s) from today.` });
        }

        if (!hasRazorpayConfig || !razorpay) {
            return res.status(500).json({ error: "Payment is not configured on server." });
        }

        const pricePerChildINR = calculatePrice(date);
        const amountINR = pricePerChildINR * parsedChildrenCount;

        await cleanupExpiredPendingBookings(date, time);

        const blockedBooking = await Booking.findOne({ date, time, status: 'BLOCKED' });
        if (blockedBooking) {
            return res.status(409).json({ error: "Selected slot is unavailable. Please choose another slot." });
        }

        const order = await razorpay.orders.create({
            amount: amountINR * 100,
            currency: "INR",
            receipt: `rcpt_${Date.now()}`
        });

        const newBooking = new Booking({
            date,
            time,
            name,
            phone,
            children_count: parsedChildrenCount,
            amount: amountINR,
            order_id: order.id,
            status: 'PENDING'
        });

        await newBooking.save();

        res.json({
            order_id: order.id,
            amount: amountINR,
            price_per_child: pricePerChildINR,
            key_id: RAZORPAY_KEY_ID,
            name,
            phone,
            children_count: parsedChildrenCount
        });

    } catch (err) {
        if (err.name === 'ValidationError') {
            const messages = Object.values(err.errors).map(val => val.message);
            return res.status(400).json({ error: messages.join(', ') });
        }
        if (err.code === 11000) {
            return res.status(409).json({ error: "Selected slot is already booked. Please choose another slot." });
        }
        console.error("Order creation error:", err);
        res.status(500).json({ error: "Failed to create order" });
    }
});

// Verify payment
app.post('/api/book/verify', bookingLimiter, async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

        if (!hasRazorpayConfig || !razorpay) {
            return res.status(500).json({ error: "Payment is not configured on server." });
        }

        const hmac = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET);
        hmac.update(`${razorpay_order_id}|${razorpay_payment_id}`);

        const expectedSignature = hmac.digest('hex');

        if (expectedSignature === razorpay_signature) {
            const result = await Booking.updateOne(
                { order_id: razorpay_order_id, status: 'PENDING' },
                { $set: { status: 'CONFIRMED', payment_id: razorpay_payment_id } }
            );

            if (result.matchedCount === 0) {
                return res.status(400).json({ error: "Booking is already confirmed or expired." });
            }

            return res.json({ success: true });
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
app.get('/api/settings', async (req, res) => {
    try {
        const settings = await getBookingSettings();
        res.json(settings);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/login', adminAuthLimiter, (req, res) => {
    const { password } = req.body || {};
    verifyAdminPassword(password, (err, isValid) => {
        if (err) return res.status(500).json({ error: 'Login failed.' });
        if (!isValid) return res.status(401).json({ error: 'Invalid credentials.' });

        const token = jwt.sign({ role: 'admin' }, ADMIN_JWT_SECRET, { expiresIn: ADMIN_TOKEN_TTL });
        res.cookie(ADMIN_COOKIE_NAME, token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: 12 * 60 * 60 * 1000
        });
        return res.json({ success: true });
    });
});

app.post('/api/admin/logout', (req, res) => {
    res.clearCookie(ADMIN_COOKIE_NAME);
    return res.json({ success: true });
});

app.get('/api/admin/me', requireAdmin, (req, res) => {
    return res.json({ authenticated: true });
});

/* =========================
   🔧 ADMIN APIs
========================= */

// Get bookings
app.get('/api/admin/bookings', requireAdmin, adminApiLimiter, async (req, res) => {
    try {
        const date = req.query.date;
        const all = req.query.all === '1';

        let query = {};
        if (!all && date) {
            query.date = date;
        }

        const bookings = await Booking.find(query).sort({ date: -1 });
        res.json(bookings);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Export bookings CSV
app.get('/api/admin/bookings/export', requireAdmin, adminApiLimiter, async (req, res) => {
    try {
        const date = req.query.date;
        const all = req.query.all === '1';

        let query = {};
        if (!all && date) {
            query.date = date;
        }

        const bookings = await Booking.find(query).sort({ date: -1, time: 1 });

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
            ...bookings.map((row) => headers.map((key) => escapeCsv(row[key])).join(","))
        ];
        const csvContent = lines.join("\n");
        const safeDate = all ? "all" : (date || "all");

        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="bookings-${safeDate}.csv"`);
        return res.status(200).send(csvContent);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Read booking window setting
app.get('/api/admin/settings', requireAdmin, adminApiLimiter, async (req, res) => {
    try {
        const settings = await getBookingSettings();
        res.json(settings);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update booking window setting
app.put('/api/admin/settings', requireAdmin, adminApiLimiter, async (req, res) => {
    try {
        const parsedDays = Number.parseInt(req.body?.advance_booking_days, 10);
        if (Number.isNaN(parsedDays) || parsedDays < 1 || parsedDays > 60) {
            return res.status(400).json({ error: "advance_booking_days must be between 1 and 60." });
        }

        await Setting.updateOne(
            { key: 'advance_booking_days' },
            { $set: { value: String(parsedDays) } },
            { upsert: true }
        );

        res.json({ success: true, advance_booking_days: parsedDays });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Reset day
app.post('/api/admin/reset', requireAdmin, adminApiLimiter, async (req, res) => {
    try {
        const { date } = req.body;
        if (!date) return res.status(400).json({ error: "Date required" });

        await Booking.deleteMany({ date: date });
        res.json({ message: "Reset successful" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Toggle slot
app.put('/api/admin/slots/toggle', requireAdmin, adminApiLimiter, async (req, res) => {
    try {
        const { date, time, is_available } = req.body;

        if (!date || !time || is_available === undefined) {
            return res.status(400).json({ error: "Missing fields" });
        }

        if (is_available) {
            await Booking.deleteMany({ date, time, status: 'BLOCKED' });
            res.json({ message: "Slot available" });
        } else {
            const newBooking = new Booking({
                date,
                time,
                name: 'Admin Blocked',
                status: 'BLOCKED'
            });
            await newBooking.save();
            res.json({ message: "Slot blocked" });
        }
    } catch (err) {
        if (err.code === 11000) {
             return res.json({ message: "Slot already blocked or booked" });
        }
        res.status(500).json({ error: err.message });
    }
});

/* =========================
   🚀 START SERVER
========================= */
app.listen(PORT, () => {
    console.log(`🚀 Server running on PORT ${PORT}`);
});
