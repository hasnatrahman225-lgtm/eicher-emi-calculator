const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ limit: '25mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public'))); // Serve the frontend from the public folder

// Gemini AI Config
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || Buffer.from('QVEuQWI4Uk42Sm90NE96dy1xd3pMRkthY1dDNTd0S0YtNkpOMVI3Z2NxOEhPZU5yZWpaend=', 'base64').toString('utf-8');
// Config
const SMS_API_URL = 'http://api.greenweb.com.bd/api.php?json';
const SMS_API_TOKEN = process.env.SMS_API_TOKEN || '110630013241785089604183b4b70f7c815a934e72e50dc5f2acd';
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://hasnatrahman225_db_user:hUAe1N2D0rClI34e@cluster0.rns2i2o.mongodb.net/?appName=Cluster0';

// Serverless MongoDB Connection Middleware
app.use(async (req, res, next) => {
    if (mongoose.connection.readyState !== 1) {
        try {
            await mongoose.connect(MONGO_URI);
            console.log('Connected to MongoDB');
            await initDefaultAdmin();
        } catch (err) {
            console.error('MongoDB connection error:', err);
        }
    }
    next();
});

// MongoDB Schemas
const userSchema = new mongoose.Schema({
    phone: { type: String, required: true, unique: true },
    password: { type: String, default: null }, // Null if password not set yet
    role: { type: String, enum: ['Admin', 'Division', 'Field'], default: 'Field' },
    devices: [{ type: String }] // Store up to 2 unique device IDs
});

const otpSchema = new mongoose.Schema({
    phone: { type: String, required: true, unique: true },
    otp: { type: String, required: true },
    expiresAt: { type: Date, required: true, index: { expires: '5m' } } // Auto delete after 5m
});

const User = mongoose.model('User', userSchema);
const Otp = mongoose.model('Otp', otpSchema);

const loginAttemptSchema = new mongoose.Schema({
    phone: { type: String, required: true },
    deviceId: { type: String },
    ipAddress: { type: String },
    userAgent: { type: String },
    timestamp: { type: Date, default: Date.now }
});
const LoginAttempt = mongoose.model('LoginAttempt', loginAttemptSchema);

async function logFailedAttempt(req, phone, deviceId) {
    try {
        await LoginAttempt.create({
            phone,
            deviceId,
            ipAddress: req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'Unknown',
            userAgent: req.headers['user-agent'] || 'Unknown'
        });
    } catch(e) {
        console.error("Failed to log attempt", e);
    }
}

// Create default admin on startup if it doesn't exist
async function initDefaultAdmin() {
    const adminExists = await User.findOne({ phone: '01700000000' });
    if (!adminExists) {
        await User.create({ phone: '01700000000', password: 'admin', role: 'Admin' });
        console.log("Default Admin Created (01700000000 / admin)");
    }
}

// Helper: Send SMS
async function sendSMS(to, message) {
    if (SMS_API_TOKEN === 'YOUR_TOKEN_HERE') {
        console.warn(`[MOCK SMS] To: ${to}, Message: ${message}`);
        return { status: 'mocked' };
    }
    try {
        const params = new URLSearchParams();
        params.append('token', SMS_API_TOKEN);
        params.append('to', to);
        params.append('message', message);
        
        const response = await axios.post(SMS_API_URL, params);
        console.log("SMS Response:", response.data);
        return response.data;
    } catch (error) {
        console.error('Error sending SMS:', error.message);
        throw error;
    }
}

// Helper: Generate OTP
function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString(); // 6 digit OTP
}

// Route: Send OTP (Must be a whitelisted user)
app.post('/api/send-otp', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number is required' });

    try {
        // WHITELIST CHECK
        const user = await User.findOne({ phone });
        if (!user) {
            return res.status(403).json({ error: 'This phone number is not authorized to use the app. Contact Admin.' });
        }

        const otp = generateOTP();
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 mins

        await Otp.findOneAndUpdate(
            { phone },
            { otp, expiresAt },
            { upsert: true, new: true }
        );

        const message = `Your Eicher App verification code is: ${otp}. It is valid for 5 minutes.`;
        await sendSMS(phone, message);
        
        res.json({ success: true, message: 'OTP sent successfully' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Server error' });
    }
});

// Route: Verify OTP & Login
app.post('/api/verify-otp', async (req, res) => {
    const { phone, otp } = req.body;
    if (!phone || !otp) return res.status(400).json({ error: 'Phone and OTP required' });

    try {
        const otpRecord = await Otp.findOne({ phone, otp });
        if (!otpRecord) return res.status(400).json({ error: 'Invalid or expired OTP' });
        if (otpRecord.expiresAt < new Date()) return res.status(400).json({ error: 'OTP expired' });

        // Clean up OTP
        await Otp.deleteOne({ phone });

        // Get user role
        const user = await User.findOne({ phone });
        if (!user) return res.status(403).json({ error: 'User not authorized' });

        const deviceId = req.body.deviceId;
        if (!deviceId) return res.status(400).json({ error: 'Device ID required' });

        // Device Limit Logic
        const hasDevice = user.devices.includes(deviceId);
        if (!hasDevice) {
            if (user.role !== 'Admin' && user.devices.length >= 2) {
                await logFailedAttempt(req, phone, deviceId);
                return res.status(403).json({ error: 'Device limit reached! Max 2 devices allowed. Please contact Admin.' });
            } else {
                user.devices.push(deviceId);
                await user.save();
            }
        }

        res.json({ success: true, role: user.role, hasPassword: !!user.password });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Route: Set/Reset Password
app.post('/api/set-password', async (req, res) => {
    const { phone, newPassword } = req.body;
    if (!phone || !newPassword) return res.status(400).json({ error: 'Phone and New Password required' });

    try {
        const user = await User.findOneAndUpdate({ phone }, { password: newPassword }, { new: true });
        if (!user) return res.status(404).json({ error: 'User not found' });
        
        res.json({ success: true, message: 'Password updated successfully' });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Route: Password Login
app.post('/api/login', async (req, res) => {
    const { phone, password, deviceId } = req.body;
    if (!phone || !password || !deviceId) return res.status(400).json({ error: 'Phone, Password and Device ID required' });

    try {
        const user = await User.findOne({ phone });
        if (!user || user.password !== password) {
            return res.status(401).json({ error: 'Invalid phone number or password' });
        }
        
        // Device Limit Logic
        const hasDevice = user.devices.includes(deviceId);
        if (!hasDevice) {
            if (user.role !== 'Admin' && user.devices.length >= 2) {
                await logFailedAttempt(req, phone, deviceId);
                return res.status(403).json({ error: 'Device limit reached! Max 2 devices allowed. Please contact Admin.' });
            } else {
                // Register new device
                user.devices.push(deviceId);
                await user.save();
            }
        }

        res.json({ success: true, role: user.role });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ==========================================
// ADMIN USER MANAGEMENT ROUTES
// ==========================================

// In a production app, these should be protected by a JWT token. 
// For simplicity, we are verifying admin authority by expecting the requester's phone in the body.
// Expecting { adminPhone: "...", targetPhone: "...", newRole: "..." }

async function verifyAdmin(phone) {
    if (!phone) return false;
    const admin = await User.findOne({ phone });
    return admin && admin.role === 'Admin';
}

// Get all users
app.post('/api/admin/users', async (req, res) => {
    const { adminPhone } = req.body;
    if (!(await verifyAdmin(adminPhone))) return res.status(403).json({ error: 'Forbidden' });

    try {
        const users = await User.find({}, '-password'); // exclude password
        res.json({ success: true, users });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Add or Update User
app.post('/api/admin/add-user', async (req, res) => {
    const { adminPhone, targetPhone, role } = req.body;
    if (!(await verifyAdmin(adminPhone))) return res.status(403).json({ error: 'Forbidden' });
    if (!targetPhone || !role) return res.status(400).json({ error: 'Missing parameters' });

    try {
        await User.findOneAndUpdate(
            { phone: targetPhone },
            { role: role },
            { upsert: true, new: true }
        );
        res.json({ success: true, message: 'User added/updated successfully' });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Delete User
app.post('/api/admin/delete-user', async (req, res) => {
    const { adminPhone, targetPhone } = req.body;
    if (!(await verifyAdmin(adminPhone))) return res.status(403).json({ error: 'Forbidden' });
    
    // Prevent admin from deleting themselves
    if (adminPhone === targetPhone) return res.status(400).json({ error: 'Cannot delete yourself' });

    try {
        await User.deleteOne({ phone: targetPhone });
        res.json({ success: true, message: 'User deleted' });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Reset Devices
app.post('/api/admin/reset-devices', async (req, res) => {
    const { adminPhone, targetPhone } = req.body;
    if (!(await verifyAdmin(adminPhone))) return res.status(403).json({ error: 'Forbidden' });
    if (!targetPhone) return res.status(400).json({ error: 'Target phone required' });

    try {
        await User.updateOne({ phone: targetPhone }, { devices: [] });
        res.json({ success: true, message: 'Devices reset successfully' });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Get Blocked Logins
app.post('/api/admin/blocked-logins', async (req, res) => {
    const { adminPhone } = req.body;
    if (!(await verifyAdmin(adminPhone))) return res.status(403).json({ error: 'Forbidden' });

    try {
        const logs = await LoginAttempt.find().sort({ timestamp: -1 }).limit(50);
        res.json({ success: true, logs });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});


// Gemini AI NID Scanner API
app.post('/api/scan-nid', async (req, res) => {
    const { imageFront, imageBack } = req.body;
    if (!imageFront && !imageBack) {
        return res.status(400).json({ error: 'At least one NID image (Front or Back) is required' });
    }

    try {
        const parts = [
            {
                text: `You are an expert OCR parser for Bangladeshi National ID (NID) cards.
Analyze the provided NID image(s) (Front and/or Back side of Smart NID or Old laminated NID).
Extract the customer's personal details and output ONLY a valid raw JSON object with these exact keys:
{
  "nidNumber": "extracted NID number (clean numbers only, e.g. 10, 13, or 17 digits)",
  "name": "Customer Name in English (transliterate or use English name if present, e.g. Md Motiur Rahman)",
  "fatherOrHusbandName": "Father's or Husband's name in English/Bangla",
  "motherName": "Mother's name in English/Bangla",
  "presentAddress": "Present Address / Address text on back side",
  "permanentAddress": "Permanent Address / Address text on back side",
  "dob": "Date of Birth (e.g. 15 May 1990 or 1990-05-15)"
}

Rules:
- Output strictly raw JSON. Do NOT wrap in markdown codeblocks.
- If any field is not visible or not found, set its value to "".`
            }
        ];

        const addImagePart = (base64Str) => {
            if (!base64Str) return;
            const matches = base64Str.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
            if (matches) {
                parts.push({
                    inlineData: {
                        mimeType: matches[1],
                        data: matches[2]
                    }
                });
            } else {
                parts.push({
                    inlineData: {
                        mimeType: 'image/jpeg',
                        data: base64Str
                    }
                });
            }
        };

        if (imageFront) addImagePart(imageFront);
        if (imageBack) addImagePart(imageBack);

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${GEMINI_API_KEY}`;
        const response = await axios.post(geminiUrl, {
            contents: [{ parts }]
        }, { headers: { 'Content-Type': 'application/json' }, timeout: 30000 });

        const candidateText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        let cleaned = candidateText.replace(/```json/gi, '').replace(/```/g, '').trim();
        let parsedData = {};
        try {
            parsedData = JSON.parse(cleaned);
        } catch (e) {
            parsedData = {
                nidNumber: (cleaned.match(/"nidNumber"\s*:\s*"([^"]+)"/) || [])[1] || "",
                name: (cleaned.match(/"name"\s*:\s*"([^"]+)"/) || [])[1] || "",
                fatherOrHusbandName: (cleaned.match(/"fatherOrHusbandName"\s*:\s*"([^"]+)"/) || [])[1] || "",
                motherName: (cleaned.match(/"motherName"\s*:\s*"([^"]+)"/) || [])[1] || "",
                presentAddress: (cleaned.match(/"presentAddress"\s*:\s*"([^"]+)"/) || [])[1] || "",
                permanentAddress: (cleaned.match(/"permanentAddress"\s*:\s*"([^"]+)"/) || [])[1] || "",
                dob: (cleaned.match(/"dob"\s*:\s*"([^"]+)"/) || [])[1] || ""
            };
        }

        res.json({ success: true, data: parsedData });
    } catch (err) {
        console.error('NID OCR scan error:', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed to scan NID card: ' + (err.response?.data?.error?.message || err.message) });
    }
});

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`Eicher EMI Backend running on http://localhost:${PORT}`);
    });
}

// Export for Vercel Serverless
module.exports = app;
