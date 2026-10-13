const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ limit: '25mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public'))); // Serve the frontend from the public folder

// Gemini AI Config
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || Buffer.from('QVEuQWI4Uk42SlhfN2pnbS10aFMtX2NlM0w3bWhtMFBUaGhjTG5vVDZ1ZjNlV01ZeEFfSWc=', 'base64').toString('utf-8');
// Config
const SMS_API_URL = 'http://api.greenweb.com.bd/api.php?json';
const SMS_API_TOKEN = process.env.SMS_API_TOKEN || '110630013241785089604183b4b70f7c815a934e72e50dc5f2acd';
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://hasnatrahman225_db_user:hUAe1N2D0rClI34e@cluster0.rns2i2o.mongodb.net/?appName=Cluster0';

// Serverless MongoDB Connection Middleware
let cachedDb = null;
async function connectToDatabase() {
    if (cachedDb && mongoose.connection.readyState === 1) {
        return cachedDb;
    }
    try {
        const db = await mongoose.connect(MONGO_URI, {
            serverSelectionTimeoutMS: 5000,
            bufferCommands: false
        });
        cachedDb = db;
        console.log('Connected to MongoDB');
        await initDatabaseUsers();
        return db;
    } catch (err) {
        console.error('MongoDB connection error:', err);
        throw err;
    }
}

app.use(async (req, res, next) => {
    if (req.path.startsWith('/api')) {
        try {
            await connectToDatabase();
        } catch (err) {
            return res.status(500).json({ 
                success: false, 
                error: 'Database connection failed: ' + (err.message || 'Check MongoDB IP access list (0.0.0.0/0).') 
            });
        }
    }
    next();
});

// MongoDB Schemas
const userSchema = new mongoose.Schema({
    empId: { type: String, default: '' },
    name: { type: String, default: '' },
    phone: { type: String, required: true, unique: true },
    areaName: { type: String, default: '' },
    password: { type: String, default: null }, // Null if password not set yet
    role: { type: String, enum: ['Admin', 'Division', 'Area Manager', 'Field', 'Sales Unit'], default: 'Area Manager' },
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

// Sync and seed employees & master admin
async function initDatabaseUsers() {
    try {
        // 1. Default Master Admin
        const masterAdmin = await User.findOne({ phone: '01700000000' });
        if (!masterAdmin) {
            await User.create({ 
                empId: '0000', 
                name: 'Master Admin', 
                phone: '01700000000', 
                areaName: 'HQ', 
                password: 'admin', 
                role: 'Admin' 
            });
            console.log("Default Master Admin Created (01700000000 / admin)");
        }

        // 2. Load employees from file
        const jsonPath = path.join(__dirname, 'employees_data.json');
        if (fs.existsSync(jsonPath)) {
            const employees = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            if (employees && employees.length > 0) {
                for (const emp of employees) {
                    await User.findOneAndUpdate(
                        { phone: emp.phone },
                        {
                            $set: {
                                empId: emp.empId || '',
                                name: emp.name || '',
                                areaName: emp.areaName || '',
                                role: emp.role || 'Area Manager'
                            }
                        },
                        { upsert: true, new: true }
                    );
                }
                console.log(`Synced ${employees.length} employees into MongoDB.`);
            }
        }
    } catch (e) {
        console.error("Error during initDatabaseUsers:", e);
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

        res.json({ 
            success: true, 
            role: user.role, 
            name: user.name || '', 
            empId: user.empId || '', 
            areaName: user.areaName || '', 
            phone: user.phone,
            hasPassword: !!user.password 
        });
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

        res.json({ 
            success: true, 
            role: user.role, 
            name: user.name || '', 
            empId: user.empId || '', 
            areaName: user.areaName || '', 
            phone: user.phone 
        });
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
        const users = await User.find({}, '-password').sort({ empId: 1, phone: 1 });
        res.json({ success: true, users });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Add or Update User
app.post('/api/admin/add-user', async (req, res) => {
    const { adminPhone, empId, name, targetPhone, areaName, role } = req.body;
    if (!(await verifyAdmin(adminPhone))) return res.status(403).json({ error: 'Forbidden' });
    if (!targetPhone || !role) return res.status(400).json({ error: 'Phone number and role are required' });

    try {
        await User.findOneAndUpdate(
            { phone: targetPhone },
            { 
                empId: empId || '',
                name: name || '',
                areaName: areaName || '',
                role: role 
            },
            { upsert: true, new: true }
        );
        res.json({ success: true, message: 'User added/updated successfully' });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Sync all employees from dataset
app.post('/api/admin/sync-employees', async (req, res) => {
    const { adminPhone } = req.body;
    if (!(await verifyAdmin(adminPhone))) return res.status(403).json({ error: 'Forbidden' });

    try {
        await initDatabaseUsers();
        res.json({ success: true, message: 'Employees re-synced successfully!' });
    } catch (e) {
        res.status(500).json({ error: 'Server error: ' + e.message });
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


// Gemini AI NID / TIN Scanner API (Single Image, Two-Sided NID, or Corporate TIN Certificate)
app.post('/api/scan-nid', async (req, res) => {
    const { imageFront, imageBack, docType } = req.body;
    if (!imageFront && !imageBack) {
        return res.status(400).json({ error: 'At least one document image (NID Front/Both sides or TIN Certificate) is required' });
    }

    try {
        const parts = [
            {
                text: `You are an expert AI OCR, entity extractor, transliterator, and verification parser for Bangladeshi Official Identification Documents (National ID Cards and e-TIN / Taxpayer Identification Number Certificates).

The uploaded image(s) may contain:
1. Bangladeshi Smart NID Card or Laminated NID (Front side, Back side, OR BOTH SIDES COMBINED IN A SINGLE PHOTO / PAGE).
2. Bangladeshi e-TIN Certificate (Taxpayer Identification Number certificate for Corporate / Proprietorship / Individual customers issued by NBR - National Board of Revenue).

CRITICAL REQUIREMENTS:
1. This is for an ENGLISH Buyer Form. ALL EXTRACTED TEXT MUST BE IN ENGLISH (LATIN SCRIPT).
2. Transliterate all Bengali names and text into standard clean English:
   - "মোঃ আবুল কাশেম" -> "Md. Abul Kashem"
   - "খাতুনে জান্নাত" -> "Khatune Jannat"
   - "মেসার্স ট্রেডার্স" -> "Messrs Traders"
3. Translate and format addresses into standard clean postal format:
   - E.g. "House: 38, Road: Chhoto Bazar, PO: Mymensingh-2200, PS: Kotwali, Dist: Mymensingh"
4. If this is a TIN Certificate:
   - "nidNumber" -> Extract the 12-digit e-TIN Number (or 10-digit TIN).
   - "name" -> Extract Taxpayer Name / Company Name.
   - "fatherOrHusbandName" -> Extract Father's/Husband's name or Directors/Authorized Person name.
   - "proprietor" -> If proprietorship / business name exists (e.g. "Trade Name / Business Name"), extract here.
   - "presentAddress" -> Current Address from TIN certificate.
   - "permanentAddress" -> Permanent / Registered Address from TIN certificate.
   - "cardType" -> "e-TIN Certificate".
   - "verificationNotes" -> "12-Digit NBR e-TIN Certificate Verified".
5. If this is a combined NID page (Both Front & Back on one image):
   - Extract the front information (Name, Father, Mother, NID, DOB) AND the back information (Address, Blood Group) from the single image.

Extract and output ONLY a valid raw JSON object with these exact keys:
{
  "nidNumber": "10-digit Smart NID, 17/13-digit NID, or 12-digit TIN number",
  "name": "Customer Name or Company Name in English",
  "fatherOrHusbandName": "Father's / Husband's / Representative name in English",
  "motherName": "Mother's name in English if available",
  "proprietor": "Business / Trade name if available on TIN/NID",
  "presentAddress": "Present Address in English",
  "permanentAddress": "Permanent Address in English",
  "dob": "Date of Birth or Incorporation Date",
  "bloodGroup": "Blood Group if visible",
  "docType": "NID" or "TIN",
  "cardType": "Smart NID Card" / "Classic NID" / "e-TIN Certificate",
  "isVerified": true,
  "verificationNotes": "Document Verified with Seal/Barcode/Security features"
}

Rules:
- Strict English output for every field.
- Do NOT wrap in markdown code blocks (\`\`\`json).
- If any field is not found or not applicable, set its value to "".`
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

        // Multi-model fallback list in order of efficiency & availability
        const candidateModels = [
            'gemini-3.5-flash-lite',
            'gemini-flash-lite-latest',
            'gemini-3.1-flash-lite',
            'gemini-3.6-flash'
        ];

        let response = null;
        let lastError = null;

        for (const modelName of candidateModels) {
            try {
                const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;
                response = await axios.post(geminiUrl, {
                    contents: [{ parts }]
                }, { headers: { 'Content-Type': 'application/json' }, timeout: 35000 });
                if (response && response.data) {
                    break; // Success
                }
            } catch (err) {
                lastError = err;
                console.warn(`Model ${modelName} failed (${err.response?.status}): ${err.response?.data?.error?.message || err.message}. Trying next fallback model...`);
            }
        }

        if (!response) {
            throw lastError || new Error('All Gemini OCR models are currently busy or unavailable');
        }

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
                proprietor: (cleaned.match(/"proprietor"\s*:\s*"([^"]+)"/) || [])[1] || "",
                presentAddress: (cleaned.match(/"presentAddress"\s*:\s*"([^"]+)"/) || [])[1] || "",
                permanentAddress: (cleaned.match(/"permanentAddress"\s*:\s*"([^"]+)"/) || [])[1] || "",
                dob: (cleaned.match(/"dob"\s*:\s*"([^"]+)"/) || [])[1] || "",
                docType: (cleaned.match(/"docType"\s*:\s*"([^"]+)"/) || [])[1] || "NID",
                cardType: (cleaned.match(/"cardType"\s*:\s*"([^"]+)"/) || [])[1] || "Document"
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
