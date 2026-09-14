const express = require('express');
const qrcode = require('qrcode');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(express.urlencoded({ extended: true }));
const port = process.env.PORT || 3000;

let geminiApiKey = null;
let qrCodeUrl = null;
let botReady = false;
let sock = null;

// Baileys Bot Start Function
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }), // Console clear rakhne ke liye logs hide kiye hain
        printQRInTerminal: false,
        auth: state,
        browser: ['WhatsApp Human Bot', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrCodeUrl = await qrcode.toDataURL(qr);
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            botReady = false;
            if (shouldReconnect) {
                setTimeout(startBot, 3000);
            }
        } else if (connection === 'open') {
            botReady = true;
            qrCodeUrl = null;
            console.log('Bot is ready and connected!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const m = messages[0];
        
        // Khud ke messages aur bina API key ke ignore karein
        if (!m.message || m.key.fromMe || !geminiApiKey) return;

        // Message ka text nikalna
        const text = m.message.conversation || m.message.extendedTextMessage?.text;
        if (!text) return;

        try {
            const delay = (ms) => new Promise(res => setTimeout(res, ms));
            const remoteJid = m.key.remoteJid;
            const isGroup = remoteJid.includes('@g.us');
            
            // 1. Padhne ka natak (2 se 5 second delay aane ke baad)
            await delay(2000 + Math.random() * 3000);
            
            // 2. Blue Tick (Mark as read)
            await sock.readMessages([m.key]);

            // 3. AI se reply banana
            const ai = new GoogleGenAI({ apiKey: geminiApiKey });
            const context = isGroup ? "group chat mein" : "personal chat mein";
            const prompt = `Tum mere ek human dost ho. Ye baat ${context} ho rahi hai. 
            Message: "${text}". 
            Ek chhota, natural, aur hinglish reply do. Aisa lage ki ek asli insaan bina soche normally type kar raha hai.`;
            
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt
            });
            const replyText = response.text;

            // 4. Typing Status on karna (Samne wale ko "Typing..." dikhega)
            await sock.sendPresenceUpdate('composing', remoteJid);
            
            // 5. Type karne ka wait (Text jitna lamba, utna zyada wait)
            await delay(Math.min(replyText.length * 60, 5000));

            // 6. Message bhejna (Purane message ko quote karte hue)
            await sock.sendMessage(remoteJid, { text: replyText }, { quoted: m });
            
            // 7. Typing status off karna
            await sock.sendPresenceUpdate('paused', remoteJid);
            
        } catch (e) {
            console.error('Error in replying:', e);
        }
    });
}

// --- UI ROUTING ---
app.get('/', (req, res) => {
    if (!geminiApiKey) {
        return res.send(`
            <div style="text-align: center; font-family: sans-serif; margin-top: 50px;">
                <h2>Setup: Gemini API Key Daalein</h2>
                <form action="/save-api" method="POST">
                    <input type="password" name="apikey" placeholder="Paste Gemini API Key here" required style="padding: 10px; width: 300px;">
                    <button type="submit" style="padding: 10px; background: #007bff; color: white; border: none; cursor: pointer;">Save & Start</button>
                </form>
            </div>
        `);
    }

    if (botReady) {
        return res.send("<h2 style='color: green; text-align: center; margin-top:50px;'>✅ Bot successfully connect ho gaya hai aur chal raha hai!</h2>");
    }

    res.send(`
        <div style="text-align: center; font-family: sans-serif; margin-top: 50px;">
            <p style="color: green;">API Key Saved! 🔒</p>
            ${qrCodeUrl ? `
                <h2>Option 1: QR Scan Karein</h2>
                <img src="${qrCodeUrl}" style="width: 250px; height: 250px;" />
            ` : '<h3>System Loading... Page refresh karein</h3>'}
            <hr style="margin: 30px 0;">
            <h2>Option 2: Number se Pair Karein</h2>
            <form action="/pair" method="POST">
                <input type="text" name="phone" placeholder="919876543210 (Country code zaroori hai)" required style="padding: 10px; width: 250px;">
                <button type="submit" style="padding: 10px; background: #25D366; color: white; border: none;">Get Code</button>
            </form>
        </div>
    `);
});

app.post('/save-api', (req, res) => {
    geminiApiKey = req.body.apikey;
    startBot(); // API lock hone ke baad hi Baileys start hoga
    res.redirect('/');
});

app.post('/pair', async (req, res) => {
    const phone = req.body.phone.replace(/[^0-9]/g, ''); // Sirf numbers lega
    try {
        if (!sock) return res.send("<center><h3>Bot abhi start nahi hua. Piche jaakar refresh karein.</h3></center>");
        
        const code = await sock.requestPairingCode(phone);
        res.send(`
            <div style="text-align: center; margin-top: 50px; font-family: sans-serif;">
                <h2>Aapka WhatsApp Pairing Code:</h2>
                <h1 style="color: #25D366; letter-spacing: 5px;">${code}</h1>
                <p>Apne WhatsApp me "Linked Devices" -> "Link with phone number" par click karein aur ye code daalein.</p>
                <a href="/" style="padding: 10px; background: #007bff; color: white; text-decoration: none; border-radius: 5px;">Back to Home</a>
            </div>
        `);
    } catch (err) {
        res.send(`<center><h3>Error: ${err.message}</h3><a href="/">Back</a></center>`);
    }
});

app.listen(port, () => console.log(`Server running on ${port}`));
